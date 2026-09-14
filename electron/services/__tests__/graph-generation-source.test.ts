import { createRequire } from 'node:module'
import { afterEach, expect, it, vi } from 'vitest'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { getDesktopMigrationRegistry, CURRENT_DESKTOP_SCHEMA_VERSION } from '../../migrations/desktop-registry'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { migrateSchema } from '../../migrations/runner'
import { getProjectDb } from '../../database'
import { NarrativeThreadRepository } from '../../repositories/narrative-thread-repository'
import { PlotTreeRepository } from '../../repositories/plot-tree-repository'
import { textHash, type DurableGenerationRun } from '../../repositories/generation-run-repository'
import { captureGraphGenerationContext, graphGenerationTask, readGraphGenerationContext, validateGraphGenerationInput } from '../graph-generation-source'
import type { GraphGenerationContext, GraphGenerationInput } from '../../../src/shared/graph-generation'

vi.mock('../../database', () => ({ getProjectDb: vi.fn() }))
const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const databases: import('better-sqlite3').Database[] = []
afterEach(() => { databases.splice(0).forEach(db => db.close()); vi.restoreAllMocks() })
const scope = { projectId: '项目甲', epoch: 'epoch-1' }
const content = '林岚找到了铜钥匙。\r\n'
function fixture() {
  const db = new Database(':memory:'); databases.push(db)
  initializeLegacyBaselineSchema(db)
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
  db.exec("INSERT INTO project_core(id,project_name,total_chapters,synopsis) VALUES('main','真实库',10,'寻找铜钥匙'); INSERT INTO blueprints(chapter_number,title,key_events) VALUES(1,'雨夜','发现钥匙')")
  db.prepare('INSERT INTO contents(id,body) VALUES(1,?)').run(content)
  db.exec("INSERT INTO drafts(id,chapter_number,version,status,content_id,word_count) VALUES(1,1,1,'finalized',1,9)")
  db.prepare(`INSERT INTO finalization_outbox(finalization_id,draft_id,chapter_number,chapter_title,content_snapshot,content_hash,content_revision,target_file_name)
    VALUES('定稿甲',1,1,'雨夜',?,?,1,'第一章.txt')`).run(content,textHash(content))
  const plan = NarrativeThreadRepository.createPlan({title:'铜钥匙',type:'伏笔',targetStartChapter:1,targetEndChapter:2,authorIntent:'打开门'},db)
  return { db, plan, capture: (input:GraphGenerationInput,previous?:GraphGenerationContext,ignored:readonly number[]=[]) => captureGraphGenerationContext(db,input,scope,'上下文甲',previous,ignored) }
}
function run(context:GraphGenerationContext): DurableGenerationRun {
 const task=graphGenerationTask(context)
 return {binding:{projectId:scope.projectId,sourceManifest:{operation:context.kind==='plot'?'plot-tree-snapshot':context.kind==='plan'?'narrative-thread-plan-candidate':'narrative-thread-event-candidate',graphGenerationInput:context.input,graphGenerationKey:context.key,graphGenerationOriginEpoch:context.originEpoch,graphGenerationContext:context,graphGenerationContextHash:textHash(JSON.stringify(context)),graphGenerationTask:task,graphGenerationTaskHash:textHash(JSON.stringify(task))}}} as unknown as DurableGenerationRun
}

it('事件来源核对定稿章节和非负修订号，并冻结合法修订号变化', () => {
 const f=fixture(),input:GraphGenerationInput={kind:'event',planId:f.plan.id,draftId:1}
 f.db.exec('UPDATE finalization_outbox SET chapter_number=99')
 expect(()=>f.capture(input)).toThrow('GENERATION_GRAPH_FINALIZED_SOURCE_INVALID')
 f.db.exec('UPDATE finalization_outbox SET chapter_number=1,content_revision=-1')
 expect(()=>f.capture(input)).toThrow('GENERATION_GRAPH_FINALIZED_SOURCE_INVALID')
 f.db.exec('UPDATE finalization_outbox SET content_revision=0')
 const original=f.capture(input)
 expect(original).toMatchObject({contentRevision:0})
 f.db.exec('UPDATE finalization_outbox SET content_revision=3')
 expect(f.capture(input,original)).not.toEqual(original)
})

it('显式数据库读写不落全局错误库，plot旧快照只作为CAS哈希',()=>{
 const f=fixture(),other=fixture(); vi.mocked(getProjectDb).mockReturnValue(other.db)
 f.db.prepare("UPDATE project_core SET plot_tree_snapshot=? WHERE id='main'").run('旧无效快照')
 const context=f.capture({kind:'plot'})
 expect(context.kind).toBe('plot');if(context.kind!=='plot')throw new Error('类型错误')
 expect(context.sources.snapshot).toBeNull();expect(context.sources.storedSnapshotInvalid).toBeUndefined()
 expect(context.targetBaselineHash).toBe(textHash('旧无效快照'))
 PlotTreeRepository.clear(f.db)
 expect(f.db.prepare('SELECT plot_tree_snapshot FROM project_core').pluck().get()).toBe('')
 NarrativeThreadRepository.updatePlan(f.plan.id,{...f.plan,title:'本库修改'},f.db)
 expect(NarrativeThreadRepository.getPlan(f.plan.id,f.db)?.title).toBe('本库修改')
 expect(NarrativeThreadRepository.getPlan(other.plan.id,other.db)?.title).toBe('铜钥匙')
 expect(getProjectDb).not.toHaveBeenCalled()
})
it('plan冻结实际蓝图与章数，previous只保留导航metadata',()=>{
 const f=fixture(),before=f.capture({kind:'plan',chapterNumber:1})
 f.db.exec("UPDATE blueprints SET title='作者新标题'; UPDATE project_core SET total_chapters=12")
 const after=captureGraphGenerationContext(f.db,before.input,{...scope,epoch:'epoch-2'},before.key,before)
 expect(after).toMatchObject({originEpoch:'epoch-1',createdAt:before.createdAt,blueprint:{title:'作者新标题'},totalChapters:12})
 expect(after).not.toEqual(before)
 expect(()=>f.capture({kind:'plan',chapterNumber:2})).toThrow('GENERATION_GRAPH_BLUEPRINT_REQUIRED')
})
it('event不依赖角色身份，但必须是最新且outbox与正文hash一致的定稿',()=>{
 const f=fixture(),input={kind:'event' as const,planId:f.plan.id,draftId:1}
 expect(f.capture(input)).toMatchObject({kind:'event',content,source:{finalizationId:'定稿甲',contentHash:textHash(content)}})
 f.db.prepare('UPDATE contents SET body=? WHERE id=1').run('作者后改')
 expect(()=>f.capture(input)).toThrow('GENERATION_GRAPH_FINALIZED_SOURCE_INVALID')
 f.db.prepare('UPDATE contents SET body=? WHERE id=1').run(content)
 f.db.exec("INSERT INTO drafts(id,chapter_number,version,status,content_id,word_count) VALUES(2,1,2,'finalized',1,9)")
 expect(()=>f.capture(input)).toThrow('GENERATION_GRAPH_FINALIZED_SOURCE_INVALID')
})
it('忽略仅传入的已确认自身event后重新计算计划状态，外部event保留',()=>{
 const f=fixture(),input={kind:'event' as const,planId:f.plan.id,draftId:1}
 f.db.exec("INSERT INTO drafts(id,chapter_number,version,status,content_id,word_count) VALUES(5,5,1,'finalized',1,9)")
 const before=f.capture(input)
 expect(before).toMatchObject({plan:{dormantChapters:4,overdue:true}})
 const own=NarrativeThreadRepository.confirmEvent({planId:f.plan.id,draftId:1,type:'resolved',evidence:'铜钥匙',reason:'已找到'},f.db)
 expect(f.capture(input)).toMatchObject({plan:{status:'resolved',dormantChapters:0,overdue:false}})
 expect(f.capture(input,before,[own.id])).toEqual(before)
 const external=NarrativeThreadRepository.confirmEvent({planId:f.plan.id,draftId:1,type:'progressing',evidence:'铜钥匙',reason:'作者新增'},f.db)
 expect(f.capture(input,before,[own.id])).toMatchObject({plan:{status:'progressing',events:[{id:external.id}]}})
 f.db.exec("UPDATE continuity_projection_meta SET generation=generation+1 WHERE id='main'")
 expect(f.capture(input,before,[own.id])).not.toEqual(before)
})
it('输入禁止renderer附带事实或ignore IDs，manifest身份与任务篡改拒绝',()=>{
 const f=fixture()
 for(const input of [{kind:'plot',snapshot:{}},{kind:'event',planId:1,draftId:1,ignoredOwnEventIds:[1]},{kind:'plan',chapterNumber:0}])expect(()=>validateGraphGenerationInput(input as GraphGenerationInput)).toThrow()
 const context=f.capture({kind:'plan',chapterNumber:1}),valid=run(context)
 expect(readGraphGenerationContext(valid)).toEqual(context)
 for(const [key,value] of [['graphGenerationKey','伪key'],['graphGenerationOriginEpoch','伪epoch'],['operation','plot-tree-snapshot'],['graphGenerationContextHash','0'.repeat(64)],['graphGenerationInput',{kind:'plot'}]] as [string, unknown][]) {
   const forged=structuredClone(valid);forged.binding.sourceManifest={...forged.binding.sourceManifest,[key]:value}
   expect(()=>readGraphGenerationContext(forged)).toThrow()
 }
 const forged=structuredClone(valid);forged.binding.sourceManifest={...forged.binding.sourceManifest,graphGenerationTaskHash:'0'.repeat(64)}
 expect(()=>readGraphGenerationContext(forged)).toThrow('GENERATION_GRAPH_TASK_INVALID')
})
