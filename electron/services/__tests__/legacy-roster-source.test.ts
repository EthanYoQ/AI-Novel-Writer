import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, expect, it, vi } from 'vitest'
import { prepareCanonicalStorageFixture } from '../../../test/helpers/canonical-project-fixture'
import { getProjectDb } from '../../database'
import { readLegacyRosterSource, captureLegacyRosterContext, adoptLegacyCards, type AdoptLegacyCardsRequest } from '../legacy-roster-source'

vi.mock('../../database',async original=>({...await original<typeof import('../../database')>(),getProjectDb:vi.fn()}))
const Database=createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const cleanup:(()=>void)[]=[]
afterEach(()=>{cleanup.splice(0).forEach(dispose=>dispose());vi.restoreAllMocks()})
const legacy='  # 林岚\r\n旧角色原文。  '
function fixture(cards=true) {
 const base=path.resolve('.runtime/.cache/novel-quality-modernization/legacy-roster-source-tests');fs.mkdirSync(base,{recursive:true})
 const root=fs.mkdtempSync(path.join(base,'项目-'));prepareCanonicalStorageFixture(root)
 const file=path.join(root,'.ai-novel','project.db');let db=new Database(file)
 db.exec("INSERT INTO project_core(id,project_name,genre,writing_language) VALUES('main','旧角色','奇幻','zh-CN')")
 db.prepare("UPDATE character_roster_meta SET migration_state=?,legacy_markdown=? WHERE id='main'").run(cards?'legacy_cards_preserved':'legacy_markdown_pending',legacy)
 if(cards){db.exec("INSERT INTO characters(character_id,name,cs_location,static_provenance,cs_provenance) VALUES('角色甲','林岚','北塔','{\"kind\":\"legacy\"}','{}'); INSERT INTO character_aliases VALUES('角色甲','旧名字','旧来源',0,NULL)")}
 cleanup.push(()=>{db.close();fs.rmSync(root,{recursive:true,force:true})})
 return {get db(){return db},reopen:()=>{db.close();db=new Database(file)},request:():AdoptLegacyCardsRequest=>{
  const source=readLegacyRosterSource(db);return {operationId:'采用甲',expectedRevision:source.snapshot.revision,expectedIdentityRevision:source.identityRevision,expectedLegacyHash:source.legacyHash,expectedFactsHash:source.factsHash}
 }}
}
const facts=(db:import('better-sqlite3').Database)=>({characters:db.prepare('SELECT * FROM characters').all(),aliases:db.prepare('SELECT * FROM character_aliases').all(),relations:db.prepare('SELECT * FROM character_relationships').all()})

it('捕获真实M02原文/genre/语言而不读全局错误库，只有空身份pending可模型',()=>{
 const f=fixture(false),other=fixture();vi.mocked(getProjectDb).mockReturnValue(other.db)
 const before=f.db.prepare('SELECT total_changes()').pluck().get(),source=captureLegacyRosterContext(f.db)
 expect(source).toMatchObject({rawLegacy:legacy,activeIds:[],genre:'奇幻',writingLanguage:'zh-CN',snapshot:{migrationState:'legacy_markdown_pending'}})
 expect(f.db.prepare('SELECT total_changes()').pluck().get()).toBe(before)
 expect(getProjectDb).not.toHaveBeenCalled()
 expect(()=>captureLegacyRosterContext(other.db)).toThrow('LEGACY_ROSTER_MODEL_SOURCE_REQUIRED')
 f.db.exec("INSERT INTO characters(character_id,name) VALUES('新角色','作者新建')")
 expect(()=>captureLegacyRosterContext(f.db)).toThrow('LEGACY_ROSTER_MODEL_SOURCE_REQUIRED')
})
it('无模型采用只重建projection+ready，角色/别名/状态/原文原字节保全',()=>{
 const f=fixture(),before=facts(f.db),request=f.request(),receipt=adoptLegacyCards(f.db,request)
 expect(receipt).toMatchObject({success:true,activeIds:['角色甲'],snapshot:{status:'ready',migrationState:'ready',legacyMarkdown:legacy}})
 expect(facts(f.db)).toEqual(before)
 expect(f.db.prepare('SELECT legacy_markdown FROM character_roster_meta').pluck().get()).toBe(legacy)
 const row=f.db.prepare('SELECT operation_id,receipt_json FROM character_identity_approvals').get() as {operation_id:string;receipt_json:string}
 expect(row.operation_id).toBe('legacy-cards-adoption:采用甲')
 expect(JSON.parse(row.receipt_json)).toMatchObject({version:1,kind:'legacy-cards-adoption',request,receipt})
})
it('原ACK在重开和作者后改后只读返回，不重复投影覆盖',()=>{
 const f=fixture(),request=f.request(),saved=adoptLegacyCards(f.db,request)
 f.db.exec("UPDATE characters SET name='作者新名',cs_location='作者新状态'; UPDATE project_core SET characters_arch='作者后来投影'")
 f.reopen();const before=f.db.prepare('SELECT total_changes()').pluck().get()
 expect(adoptLegacyCards(f.db,request)).toEqual(saved)
 expect(f.db.prepare('SELECT total_changes()').pluck().get()).toBe(before)
 expect(f.db.prepare('SELECT characters_arch FROM project_core').pluck().get()).toBe('作者后来投影')
 expect(f.db.prepare('SELECT name FROM characters').pluck().get()).toBe('作者新名')
 expect(()=>adoptLegacyCards(f.db,{...request,expectedRevision:request.expectedRevision+1})).toThrow('LEGACY_ROSTER_ADOPTION_NONCE_CONFLICT')
})
it.each(["UPDATE characters SET cs_location='改状态'","UPDATE characters SET retired=1","UPDATE character_aliases SET name='改别名'","UPDATE character_identity_meta SET revision=revision+1","UPDATE character_roster_meta SET revision=revision+1","UPDATE character_roster_meta SET legacy_markdown='改原文'"])( '采用拒绝并发事实变化：%s',sql=>{
 const f=fixture(),request=f.request();f.db.exec(sql)
 expect(()=>adoptLegacyCards(f.db,request)).toThrow()
 expect(f.db.prepare('SELECT COUNT(*) FROM character_identity_approvals').pluck().get()).toBe(0)
 expect(f.db.prepare('SELECT migration_state FROM character_roster_meta').pluck().get()).toBe('legacy_cards_preserved')
})
it('零活跃身份拒绝，ACK存储失败令projection/ready全事务回滚',()=>{
 const empty=fixture(false)
 expect(()=>adoptLegacyCards(empty.db,empty.request())).toThrow('LEGACY_ROSTER_CARDS_REQUIRED')
 const f=fixture(),request=f.request(),before=f.db.prepare('SELECT * FROM character_roster_meta').all(),projection=f.db.prepare('SELECT characters_arch FROM project_core').pluck().get()
 f.db.exec("CREATE TRIGGER reject_adopt BEFORE INSERT ON character_identity_approvals BEGIN SELECT RAISE(ABORT,'合成回执失败'); END")
 expect(()=>adoptLegacyCards(f.db,request)).toThrow('合成回执失败')
 expect(f.db.prepare('SELECT * FROM character_roster_meta').all()).toEqual(before)
 expect(f.db.prepare('SELECT characters_arch FROM project_core').pluck().get()).toBe(projection)
 expect(f.db.prepare('SELECT COUNT(*) FROM character_identity_approvals').pluck().get()).toBe(0)
})
it('回执kind/hash篡改不可作为历史ACK',()=>{
 const f=fixture(),request=f.request();adoptLegacyCards(f.db,request)
 f.db.exec("UPDATE character_identity_approvals SET receipt_json=json_set(receipt_json,'$.kind','author-edit')")
 expect(()=>adoptLegacyCards(f.db,request)).toThrow('LEGACY_ROSTER_ADOPTION_RECEIPT_INVALID')
})
it('实际关系与退役角色字段都进入事实hash，meta.fact_hash不授予采用',()=>{
 const f=fixture()
 f.db.exec("INSERT INTO characters(character_id,name,retired) VALUES('角色乙','旧人物',1); INSERT INTO character_identity_approvals VALUES('原作者批准','原哈希','{}'); INSERT INTO character_relationships VALUES('关系甲','角色甲','角色乙','认识','林岚','旧人物','{}','原作者批准')")
 const request=f.request(),before=f.db.prepare('SELECT fact_hash FROM character_roster_meta').pluck().get()
 f.db.exec("UPDATE character_relationships SET relation='作者新关系'")
 expect(f.db.prepare('SELECT fact_hash FROM character_roster_meta').pluck().get()).toBe(before)
 expect(()=>adoptLegacyCards(f.db,request)).toThrow('LEGACY_ROSTER_ADOPTION_SOURCE_CHANGED')
 const later=f.request();f.db.exec("UPDATE characters SET background='退役角色新原文' WHERE character_id='角色乙'")
 expect(()=>adoptLegacyCards(f.db,later)).toThrow('LEGACY_ROSTER_ADOPTION_SOURCE_CHANGED')
})
