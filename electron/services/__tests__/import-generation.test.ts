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
import { generationOutputContract, type BeginGenerationRequest } from '../../../src/shared/generation-owner-contract'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import type { GenerationRunServiceDependencies } from '../generation-run-service'

vi.mock('../../database', async importOriginal => ({ ...await importOriginal<typeof import('../../database')>(), getProjectDb: vi.fn(), getCurrentProjectPath: vi.fn() }))
const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); vi.restoreAllMocks() })
const prose = '林岚走进北塔，灯火照亮了石阶。'.repeat(20)
function fixture(dispatch?: GenerationRunServiceDependencies['dispatch']) {
  const base = path.resolve('.runtime/.cache/novel-quality-modernization/import-owner-tests')
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, 'owner-'))
  prepareCanonicalStorageFixture(root)
  vi.mocked(getCurrentProjectPath).mockReturnValue(root)
  let db = new Database(path.join(root, '.ai-novel', 'project.db'))
  vi.mocked(getProjectDb).mockReturnValue(db)

  db.exec("INSERT INTO project_core(id,project_name,words_per_chapter) VALUES('main','合成审稿',100); INSERT INTO blueprints(chapter_number,title) VALUES(1,'北塔');")
  db.prepare('INSERT INTO contents(id,body) VALUES(1,?)').run(prose)
  db.exec("INSERT INTO drafts(id,chapter_number,version,status,content_id,word_count) VALUES(1,1,1,'draft',1,280)")
  const model: ModelProfile = { id: 'synthetic', name: '合成模型', provider: 'openai', protocol: 'openai', modelName: 'gpt-4.1', apiKey: 'synthetic-key', baseUrl: 'https://api.openai.com/v1', temperature: 0.7, maxTokens: 2048, purposes: ['generation'], capabilities: { contextWindowTokens: 32768, maxOutputTokens: 2048, reasoning: false, structuredOutput: true, usage: true } }
  const spy = vi.fn<GenerationRunServiceDependencies['dispatch']>(dispatch ?? (async (_request, options) => { options.onVisible({ kind: 'delta', text: '我会检查。<tool_call>{"name":"read_project_state","arguments":{}}</tool_call>' }); return { finishReason: 'stop', usage: null } }))
  const deps = { db, projectStorageRoot: root, globalDataRoot: root, readBuiltinPrompt: (key: string) => JSON.stringify({key,content:'冻结的合成提示词',systemRole:'写作助手'}) }
  const makeOwner = (epoch: string) => createMainGenerationOwner({ database: db, projectId: 'project', epoch, assertCurrent: () => {}, leases: new ModelExecutionLeaseRegistry({ loadModel: () => model }), loadModel: () => model, dispatch: spy,
    buildBinding: (selection, modelReceipt) => buildGenerationSourceBinding(deps, { ...selection, projectId: 'project', epoch, modelReceipt, policy: MAIN_GENERATION_POLICY, outputContract: generationOutputContract(selection) }).binding,
    rebuildBinding: (previous, modelReceipt) => rebuildGenerationSourceBinding(deps, previous, epoch, modelReceipt, MAIN_GENERATION_POLICY).binding })
  const owner = makeOwner('epoch-1')
  cleanup.push(() => { owner.suspendForProjectClose(); db.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const reopenStorage = () => { owner.suspendForProjectClose(); db.close(); db = new Database(path.join(root, '.ai-novel', 'project.db')); deps.db = db; vi.mocked(getProjectDb).mockReturnValue(db); const next=makeOwner('epoch-2'); cleanup.unshift(()=>next.suspendForProjectClose()); return next }
  const content='第一章 海港\r\n林岚在港口找到了信。'
  const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
  const chapter={number:1,title:'海港',content,contentSize:Buffer.byteLength(content),contentFingerprint:hash(content)}
  ImportRunRepository.prepare({runId:'导入任务',purpose:'reference',sourceFingerprint:'a'.repeat(64),locale:'zh-CN',sourceDisplay:[{displayName:'参考小说.txt',mediaType:'text/plain',size:chapter.contentSize}],chapters:[chapter]})
  const execution=ImportRunRepository.startOrResume('导入任务','合成执行器').execution
  const binding=ImportRunRepository.resolveReferenceImportAuthority('导入任务',execution,1)
  const documentId=hash(`reference-import:${binding.stableKey}`)
  db.prepare("INSERT INTO import_reference_documents(document_id,idempotency_key_hash,content_hash,chunk_set_hash,expected_chunk_count,corpus_kind,state) VALUES(?,?,?,?,1,'reference','committed')").run(documentId,hash(binding.stableKey),binding.contentFingerprint,hash('合成块'))
  ImportRunRepository.commitReferenceImportReceipt('导入任务',execution,1,documentId)
  ImportRunRepository.completeBatch('导入任务','knowledge',createImportRunChapterBatchCheckpointId([chapter]),execution)
  ImportRunRepository.advanceStage('导入任务','knowledge','global',execution)
  const slot={runId:'导入任务',stage:'global' as const,batchId:'done'}
  const selection:BeginGenerationRequest={operation:'import-global-facts',uiActionNonce:'首次导入',modelId:model.id,promptKeys:['infer_novel_config_with_vectors','infer_novel_config'],skillStages:['planning'],selectedDraftIds:[],selectedFinalizedDraftIds:[],output:'structured-data',importSlot:slot,importExecution:{owner:execution.owner,epoch:execution.epoch}}
  return {get db(){return db},owner,spy,reopenStorage,selection,slot,content,execution}
}

import { createHash } from 'node:crypto'
import { ImportRunRepository } from '../../repositories/import-run-repository'
import { createImportRunChapterBatchCheckpointId } from '../../../src/shared/import-run'
const task={purpose:'import-global-facts',output:'structured-data' as const,messages:[{role:'user' as const,content:'归纳参考小说事实'}]}

it('同slot不同nonce加入同run，并冻结实际manifest正文',()=>{
 const f=fixture(),first=f.owner.begin(f.selection),second=f.owner.begin({...f.selection,uiActionNonce:'另一次点击'})
 expect(second.handle).toEqual(first.handle)
 expect(f.owner.readImportGeneration(f.slot)).toMatchObject({modelId:'synthetic',frozenContext:{chapters:[{content:f.content}]}})
 expect(f.spy).not.toHaveBeenCalled()
})
it.each(['stage','authority','hash'] as const)('首次begin拒绝错误%s',kind=>{
 const f=fixture()
 if(kind==='hash') f.db.exec("UPDATE import_run_chapters SET content_snapshot='篡改正文'")
 const request={...f.selection,...(kind==='stage'?{operation:'analyze-writing-style'}:{}),...(kind==='authority'?{importExecution:{owner:'伪执行器',epoch:1}}:{})}
 expect(()=>f.owner.begin(request)).toThrow()
 expect(f.spy).not.toHaveBeenCalled()
})
it('ordinal0并发只派发一次，持久请求重开仍读原artifact和model',async()=>{
 let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve})
 const f=fixture(async(_r,o)=>{await pending;o.onVisible({kind:'delta',text:'{"genre":"玄幻"}'});return {finishReason:'stop',usage:null}})
 const handle=f.owner.begin(f.selection).handle
 const first=f.owner.executeImportGeneration({execution:f.execution,handle,ordinal:0,task}),second=f.owner.executeImportGeneration({execution:f.execution,handle,ordinal:0,task})
 release();const receipt=await first
 expect(await second).toEqual(receipt);expect(f.spy).toHaveBeenCalledTimes(1)
 const stored=JSON.parse(f.db.prepare('SELECT usage_receipt_json FROM generation_attempts').pluck().get() as string)
 expect(stored.replayTask).toEqual(task)
 const next=f.reopenStorage()
 expect(next.readImportGeneration(f.slot)?.modelId).toBe('synthetic')
 const replay=await next.executeImportGeneration({handle,ordinal:0,task:{...task,messages:[{role:'user',content:'后来改变的请求'}]}})
 expect(replay.run.artifacts).toEqual(receipt.run.artifacts)
 expect(replay.outcome).toMatchObject({status:receipt.outcome.status,content:receipt.outcome.content,finishReason:receipt.outcome.finishReason})
 expect(f.spy).toHaveBeenCalledTimes(1)
})
it('ordinal gap拒绝，unknown重开不自动重发且预算保留',async()=>{
 const f=fixture(async()=>{throw new Error('合成发送结果未知')}),handle=f.owner.begin(f.selection).handle
 await expect(f.owner.executeImportGeneration({execution:f.execution,handle,ordinal:1,task})).rejects.toThrow('GENERATION_IMPORT_ORDINAL_GAP')
 const receipt=await f.owner.executeImportGeneration({execution:f.execution,handle,ordinal:0,task})
 const next=f.reopenStorage()
 const replay=await next.executeImportGeneration({handle,ordinal:0,task})
 expect(replay.run.artifacts).toEqual(receipt.run.artifacts)
 expect(replay.outcome.status).toBe(receipt.outcome.status)
 expect(next.readImportGeneration(f.slot)?.view.ledger?.physicalRequests).toBe(1)
 expect(f.spy).toHaveBeenCalledTimes(1)
})

it.each(['stage','authority'] as const)('已有slot不能用错误%s冒充合法加入',kind=>{
 const f=fixture();f.owner.begin(f.selection)
 const forged={...f.selection,uiActionNonce:'伪加入',...(kind==='stage'?{operation:'analyze-writing-style'}:{importExecution:{owner:'伪执行器',epoch:1}})}
 expect(()=>f.owner.begin(forged)).toThrow()
 expect(f.spy).not.toHaveBeenCalled()
})

it('持久replayTask被篡改时拒绝回读，不新增派发',async()=>{
 const f=fixture(async(_r,o)=>{o.onVisible({kind:'delta',text:'{"genre":"玄幻"}'});return {finishReason:'stop',usage:null}})
 const handle=f.owner.begin(f.selection).handle
 await f.owner.executeImportGeneration({execution:f.execution,handle,ordinal:0,task})
 f.db.exec("UPDATE generation_attempts SET usage_receipt_json=json_set(usage_receipt_json,'$.replayTask.purpose','篡改请求')")
 await expect(f.owner.executeImportGeneration({execution:f.execution,handle,ordinal:0,task})).rejects.toThrow('GENERATION_IMPORT_TASK_INVALID')
 expect(f.spy).toHaveBeenCalledTimes(1)
})

async function globalEffect() {
 const f=fixture(async(_r,o)=>{o.onVisible({kind:'delta',text:'{"facts":"合成"}'});return {finishReason:'stop',usage:null}})
 const handle=f.owner.begin(f.selection).handle
 await f.owner.executeImportGeneration({execution:f.execution,handle,ordinal:0,task})
 const core={genre:'现实',subGenre:'冒险',targetAudience:'通用',totalChapters:1,wordsPerChapter:900,plotStructure:'three_act',narrativePov:'third_limited',goldenFinger:'无',globalGuidance:'克制',premise:'海港来信',coreOutline:'寻找来信者',worldSetting:'海港',protagonistProfile:'林岚',worldbuilding:'海港街巷',synopsis:'找到信件'}
 const characterEntries=[{name:'林岚',role:'protagonist',gender:'未知',age:'18',appearance:'朴素',personality:'谨慎',background:'港口居民',abilities:'观察',motivation:'寻信',relationships:[],arc:'成长',notes:'待确认'}]
 ImportRunRepository.prepareEffectReceipt({runId:f.slot.runId,stage:'global',batchId:'done',effectKey:'global-facts',kind:'project-global-facts',payload:{operationId:"novel-import-global-导入任务",expectedRosterRevision:0,core,characterEntries,generationRunHandle:handle}},f.execution)
 const committed=ImportRunRepository.commitEffectReceipt(f.slot.runId,'global','done',f.execution,Date.now(),f.owner.assertImportGenerationSources)
 expect(committed.receipt.state).toBe('committed')
 expect(f.db.prepare('SELECT genre FROM project_core').pluck().get()).toBe('现实')
 ImportRunRepository.advanceStage(f.slot.runId,'global','style',f.execution)
 const styleSlot={...f.slot,stage:'style' as const}
 const style=f.owner.begin({...f.selection,operation:'analyze-writing-style',promptKeys:['analyze_writing_style'],skillStages:[],output:'visible-text',modelId:'后来不同模型',importSlot:styleSlot})
 expect(style.handle.rootActionId).toBe(handle.rootActionId)
 expect(f.owner.readImportGeneration(styleSlot)?.modelId).toBe('synthetic')
 await f.owner.executeImportGeneration({execution:f.execution,handle:style.handle,ordinal:0,task:{...task,output:'visible-text'}})
 return Object.assign(f,{style,styleSlot})
}
it('真实global effect后style继承原root/model，prepared旧epoch重开直接guard提交',async()=>{
 const f=await globalEffect(),handle=f.style.handle
 ImportRunRepository.prepareEffectReceipt({runId:f.slot.runId,stage:'style',batchId:'done',effectKey:'writing-style',kind:'project-writing-style',payload:{writingStyle:'克制而具体',generationRunHandle:handle}},f.execution)
 await expect(f.owner.executeImportGeneration({execution:f.execution,handle,ordinal:1,task:{...task,output:'visible-text'}})).rejects.toThrow('GENERATION_IMPORT_EFFECT_SEALED')
 const artifact=f.owner.read(handle).artifacts[0]!
 expect(()=>f.owner.discardCandidate(handle,artifact.artifactId)).toThrow('GENERATION_IMPORT_EFFECT_SEALED')
 const next=f.reopenStorage()
 const saved=ImportRunRepository.commitEffectReceipt(f.slot.runId,'style','done',f.execution,Date.now(),next.assertImportGenerationSources)
 expect(saved.receipt.state).toBe('committed')
 expect(f.db.prepare('SELECT writing_style FROM project_core').pluck().get()).toBe('克制而具体')
 f.db.exec("UPDATE project_core SET writing_style='作者后来修改'")
 const replay=ImportRunRepository.commitEffectReceipt(f.slot.runId,'style','done',f.execution,Date.now(),()=>{throw new Error('ACK不得重验来源')})
 expect(replay.receipt).toEqual(saved.receipt)
 expect(f.db.prepare('SELECT writing_style FROM project_core').pluck().get()).toBe('作者后来修改')
 expect(f.spy).toHaveBeenCalledTimes(2)
})
it('prepared style在来源改变后拒绝提交且不污染作者值',async()=>{
 const f=await globalEffect(),handle=f.style.handle
 ImportRunRepository.prepareEffectReceipt({runId:f.slot.runId,stage:'style',batchId:'done',effectKey:'writing-style',kind:'project-writing-style',payload:{writingStyle:'模型文风',generationRunHandle:handle}},f.execution)
 f.db.exec("UPDATE project_core SET writing_style='作者新文风'")
 expect(()=>ImportRunRepository.commitEffectReceipt(f.slot.runId,'style','done',f.execution,Date.now(),f.owner.assertImportGenerationSources)).toThrow()
 expect(f.db.prepare('SELECT writing_style FROM project_core').pluck().get()).toBe('作者新文风')
 expect(ImportRunRepository.getEffectReceipt(f.slot.runId,'style','done')?.state).toBe('prepared')
})

it('拒绝与导入stage不符的模板和输出合同',()=>{
 const f=fixture()
 expect(()=>f.owner.begin({...f.selection,promptKeys:['analyze_writing_style']})).toThrow()
 expect(()=>f.owner.begin({...f.selection,output:'visible-text'})).toThrow()
 expect(f.spy).not.toHaveBeenCalled()
})

it.each(['missing','expired'] as const)('新ordinal拒绝%s导入执行权限，零派发',async kind=>{
 const f=fixture(),handle=f.owner.begin(f.selection).handle
 if(kind==='expired') f.db.exec('UPDATE import_runs SET lease_expires_at=0')
 await expect(f.owner.executeImportGeneration({handle,ordinal:0,task,...(kind==='expired'?{execution:f.execution}:{})})).rejects.toThrow()
 expect(f.spy).not.toHaveBeenCalled()
 expect(f.db.prepare('SELECT COUNT(*) FROM generation_attempts').pluck().get()).toBe(0)
})
