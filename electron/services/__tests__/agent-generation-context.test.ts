import type { AgentGenerationInput, AgentGenerationContext } from '../../../src/shared/agent-generation'
import { buildAgentGenerationContext, validateAgentGenerationInput } from '../agent-generation-context'
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema';
import { buildGenerationSourceBinding, rebuildGenerationSourceBinding, compareGenerationSourceBindings, type GenerationSourceBindingInput } from '../generation-source-binding';
const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3');
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0))
    cleanup(); });
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function put(root: string, file: string, text: string) { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text); }
function fixture() {
    const base = path.resolve('.runtime/.cache/novel-quality-modernization/s06d-agent-context');
    fs.mkdirSync(base, { recursive: true });
    const root = fs.mkdtempSync(path.join(base, 'binding-')), projectStorageRoot = path.join(root, 'project'), globalDataRoot = path.join(root, 'global');
    fs.mkdirSync(projectStorageRoot);
    fs.mkdirSync(globalDataRoot);
    const db = new Database(path.join(root, 'source.db'));
    initializeLegacyBaselineSchema(db);
    cleanups.push(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
    db.prepare("INSERT INTO project_core(id,project_name,global_guidance) VALUES('main','项目','作者全局指导')").run();
    db.prepare("INSERT INTO blueprints(chapter_number,title,user_guidance) VALUES(2,'第二章','章指导')").run();
    db.prepare("INSERT INTO contents(id,body) VALUES(1,'原文\r\n汉字。'),(2,'未选草稿'),(3,'已定稿原文')").run();
    db.prepare("INSERT INTO drafts(id,chapter_number,version,status,content_id) VALUES(1,2,1,'draft',1),(2,3,1,'draft',2),(3,1,1,'finalized',3)").run();
    db.prepare("INSERT INTO finalization_outbox(finalization_id,draft_id,chapter_number,content_hash,content_revision,content_snapshot,target_file_name) VALUES('final-3',3,1,?,1,'已定稿原文','chapter1.txt')").run(hash('已定稿原文'));
    const h = hash('model'), input: GenerationSourceBindingInput = { projectId: 'p', epoch: 'e', operation: 'agent', chapterNumber: 2, selectedDraftIds: [1], selectedFinalizedDraftIds: [3], promptKeys: ['assistant_writing_identity'], skillStages: [], modelReceipt: { modelId: 'model', provider: 'openai', protocol: 'openai', modelName: 'synthetic', modelRevision: h, endpointFingerprint: h, capabilityEvidence: { source: { contextWindowTokens: 'unknown', maxOutputTokens: 'user-operational-cap', featureFlags: 'unknown' }, subjectFingerprint: h, contextWindowTokens: 8000, maxOutputTokens: 1000, reasoning: false, structuredOutput: false, usage: true } }, policy: { version: 'fixture-v1', maxPhysicalRequests: 2 }, outputContract: 'visible-text' };
    const deps = { db, projectStorageRoot, globalDataRoot, readBuiltinPrompt: () => JSON.stringify({ key: 'assistant_writing_identity', content: '内置助手 {{mode_instruction}}', systemRole: '不可伪造系统角色', systemSuffix: '固定工具协议' }) };
    input.agentInput = agentInput();
    return { root, db, input, deps, build: () => buildGenerationSourceBinding(deps, input) };
}

function agentInput(): AgentGenerationInput {
 return { mode: 'planning', uiLocale: 'zh-CN', userMessage: ' 原始指令\r\n ',
 historyMessages: [{role:'user',content:'原问题'},{role:'assistant',content:'旧回答'}],editorContext:'未保存草稿',
 tools:[{name:'start_workflow',description:'启动工作流',inputSchema:{type:'object',properties:{}},requiresConfirmation:true,isReadOnly:false,source:'builtin'}] }
}
const template=JSON.stringify({key:'assistant_writing_identity',content:'实际模板 {{mode_instruction}}',systemRole:'系统角色',systemSuffix:'固定尾缀'})
describe('Agent 主进程上下文与实际 SQLite 来源边界',()=>{
 it('不接受 renderer system 消息或额外系统字段',()=>{
  const input=agentInput()
  expect(()=>validateAgentGenerationInput({...input,systemPrompt:'伪造系统'} as AgentGenerationInput)).toThrow('GENERATION_AGENT_INPUT_INVALID')
  expect(()=>validateAgentGenerationInput({...input,historyMessages:[{role:'system',content:'伪造'}]} as unknown as AgentGenerationInput)).toThrow('GENERATION_AGENT_INPUT_INVALID')
 })
 it.each([{source:'mcp'},{requiresConfirmation:false},{isReadOnly:true}])('start_workflow 不能伪装为 %j',patch=>{
  const input=agentInput();Object.assign(input.tools[0]!,patch)
  expect(()=>validateAgentGenerationInput(input)).toThrow('GENERATION_AGENT_INPUT_INVALID')
 })
 it.each(['duplicate','history-limit','tools-limit','bytes-limit','empty-user'])('拒绝越界输入 %s',kind=>{
  const input=agentInput()
  if(kind==='duplicate') input.tools.push({...input.tools[0]!})
  if(kind==='history-limit') input.historyMessages=Array.from({length:33},()=>({role:'user' as const,content:'历史'}))
  if(kind==='tools-limit') input.tools=Array.from({length:257},(_,i)=>({...input.tools[0]!,name:`tool_${i}`}))
  if(kind==='bytes-limit') input.userMessage='字'.repeat(750000)
  if(kind==='empty-user') input.userMessage=' '
  expect(()=>validateAgentGenerationInput(input)).toThrow('GENERATION_AGENT_INPUT_INVALID')
 })
 it('冻结原字节/嵌套工具定义并用main core和模板构建唯一system',()=>{
  const input=agentInput(), context=buildAgentGenerationContext(input,{worldbuilding:'真实世界设定'},'zh-CN',template,template)
  input.tools[0]!.inputSchema.type='伪造';input.historyMessages[0]!.content='后来改写';input.userMessage='新指令'
  expect(context.input.tools[0]!.inputSchema.type).toBe('object')
  expect(context.initialMessages.map(m=>m.role)).toEqual(['system','user','assistant','user'])
  expect(context.initialMessages.at(-1)!.content).toBe(' 原始指令\r\n ')
  expect(context.initialMessages[0]!.content).toContain('真实世界设定')
  expect(context.initialMessages[0]!.content).toContain('当前处于规划模式')
  expect(context.initialMessages[0]!.content).toContain('未保存内容不是既定事实')
 })
 it('实际SQLite core与实际项目模板进入source hash，renderer editor上下文不替代core',()=>{
  const f=fixture()
  put(f.deps.projectStorageRoot,'prompts/assistant_writing_identity.zh-CN.json',JSON.stringify({key:'assistant_writing_identity',content:'作者覆盖模板',systemRole:'作者角色'}))
  const result=f.build(), context=result.binding.sourceManifest.agentContext as AgentGenerationContext
  expect(context.initialMessages[0]!.content).toContain('作者覆盖模板')
  expect(context.initialMessages[0]!.content).toContain('作者全局指导')
  expect(context.initialMessages[0]!.content).toContain('固定工具协议')
  expect(result.binding.sourceManifest.agentContextHash).toBe(hash(JSON.stringify(context)))
  expect(result.materials.find(m=>m.ref.sourceId==='agent-context')?.ref.contentHash).toBe(hash(JSON.stringify(context)))
  expect(compareGenerationSourceBindings(result.binding,rebuildGenerationSourceBinding(f.deps,result.binding,'新epoch').binding)).toBe(true)
 })
 it.each(['core','template','tools','user'])('变化 %s 不继承旧来源指纹',kind=>{
  const f=fixture(), initial=f.build()
  if(kind==='core') f.db.exec("UPDATE project_core SET global_guidance='作者后来指导'")
  if(kind==='template') put(f.deps.projectStorageRoot,'prompts/assistant_writing_identity.zh-CN.json',JSON.stringify({key:'assistant_writing_identity',content:'后来模板'}))
  if(kind==='tools') f.input.agentInput!.tools[0]!.description='后来工具定义'
  if(kind==='user') f.input.agentInput!.userMessage='另一作者指令'
  expect(compareGenerationSourceBindings(initial.binding,f.build().binding)).toBe(false)
  if(kind==='tools'||kind==='user') expect(compareGenerationSourceBindings(initial.binding,rebuildGenerationSourceBinding(f.deps,initial.binding,'新epoch').binding)).toBe(true)
  else expect(compareGenerationSourceBindings(initial.binding,rebuildGenerationSourceBinding(f.deps,initial.binding,'新epoch').binding)).toBe(false)
 })
 it('缺身份模板或错误模板key拒绝',()=>{
  const f=fixture();f.input.promptKeys=['draft']
  expect(f.build).toThrow('GENERATION_AGENT_PROMPT_REQUIRED')
  expect(()=>buildAgentGenerationContext(agentInput(),{},'zh-CN',JSON.stringify({key:'wrong',content:'正文'}),template)).toThrow('GENERATION_AGENT_PROMPT_INVALID')
 })
})
