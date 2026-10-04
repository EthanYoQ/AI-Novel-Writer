import { afterEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import AIOutputPanel from '../AIOutputPanel'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import { useLocaleStore } from '../../../stores/locale-store'

const projectState=useProjectStore.getState(),workflowState=useWorkflowStore.getState(),localeState=useLocaleStore.getState()
const bridge=Object.getOwnPropertyDescriptor(window,'aiNovelAPI')
let root:Root|undefined,container:HTMLDivElement|undefined
;(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true
const session={projectId:'海港',leaseId:'当前会话',projectPath:'C:/合成海港'}
const handle={projectId:session.projectId,epoch:'原会话',rootActionId:'原选区预算',runId:'原选区任务'}
const documentText='  林岚😀走进海港。\r\n原始文稿尾部  '
afterEach(async()=>{
 await act(async()=>root?.unmount());container?.remove()
 useProjectStore.setState(projectState,true);useWorkflowStore.setState(workflowState,true);useLocaleStore.setState(localeState,true)
 if(bridge)Object.defineProperty(window,'aiNovelAPI',bridge);else Reflect.deleteProperty(window,'aiNovelAPI')
 vi.restoreAllMocks()
})
async function mount(mode:'unknown'|'conflict'|'ready',delayed?:Promise<unknown>) {
 const view={handle,status:'paused',artifacts:mode==='ready'?[]:[{...handle,artifactId:'保留候选',attemptId:'原请求',text:'林岚停下脚步。',status:'failed'}],ledger:{physicalRequests:mode==='ready'?0:1}}
 const recovery={view,modelId:'原冻结模型',sourceStatus:mode==='conflict'?'conflict':'current',context:{documentText,selectedText:'林岚😀走进海港。',action:'refine'}}
 const invoke=vi.fn(async(channel:string)=>{
  if(channel==='generation:list')return [view]
  if(channel==='generation:list-batches'||channel==='db:recovery-candidate-list')return []
  if(channel==='generation:read-context')return {handle,operation:'editor-inline'}
  if(channel==='editor-inline:read-recovery')return delayed??recovery
  if(channel==='editor-inline:execute')return {run:view,outcome:{status:'completed',content:'合成结果'}}
  throw new Error(`未授权调用：${channel}`)
 })
 Object.defineProperty(window,'aiNovelAPI',{configurable:true,value:{invoke,on:()=>()=>{}}})
 useProjectStore.setState({currentProject:{id:session.projectId,path:session.projectPath,name:'海港',sessionLease:session.leaseId,novelConfig:{}} as never})
 useWorkflowStore.setState({activeRuns:[],history:[],currentRun:null});useLocaleStore.setState({locale:'zh-CN'})
 container=document.createElement('div');document.body.appendChild(container);root=createRoot(container)
 await act(async()=>root!.render(<AIOutputPanel/>))
 return {invoke,recovery}
}
const button=(label:string)=>[...container!.querySelectorAll('button')].find(item=>item.textContent===label)!
it.each(['unknown','conflict'] as const)('%s保留候选可复制，不重发或写canonical',async mode=>{
 const copy=vi.spyOn(navigator.clipboard,'writeText').mockResolvedValue()
 const {invoke}=await mount(mode)
 await vi.waitFor(()=>expect(container!.textContent).toContain('林岚停下脚步。'))
 expect(button('继续原选区任务').disabled).toBe(true)
 await act(async()=>button('复制原文稿').click())
 expect(copy).toHaveBeenCalledExactlyOnceWith(documentText)
 await act(async()=>button('复制建议').click())
 expect(copy).toHaveBeenLastCalledWith('林岚停下脚步。')
 await act(async()=>button('继续原选区任务').click())
 expect(invoke.mock.calls.every(([channel])=>['generation:list','generation:list-batches','generation:read-context','db:recovery-candidate-list','editor-inline:read-recovery'].includes(channel))).toBe(true)
})
it('零请求明确继续原handle，不begin或选择当前默认模型',async()=>{
 const {invoke}=await mount('ready')
 await vi.waitFor(()=>expect(button('继续原选区任务')).toBeDefined())
 expect(button('继续原选区任务').disabled).toBe(false)
 await act(async()=>button('继续原选区任务').click())
 expect(invoke.mock.calls.filter(([channel])=>channel==='editor-inline:execute')).toHaveLength(1)
 expect((invoke.mock.calls as unknown[][]).find(([channel])=>channel==='editor-inline:execute')?.[1]).toEqual({handle})
 expect(invoke.mock.calls.some(([channel])=>channel.includes('begin')||channel.startsWith('llm:'))).toBe(false)
})
it('旧项目延迟恢复响应不进入新项目面板',async()=>{
 let release!:(value:unknown)=>void;const delayed=new Promise(resolve=>{release=resolve})
 const {recovery,invoke}=await mount('unknown',delayed)
 await vi.waitFor(()=>expect(invoke.mock.calls.some(([channel])=>channel==='editor-inline:read-recovery')).toBe(true))
 await act(async()=>{useProjectStore.setState({currentProject:{id:'新项目',path:'C:/新项目',name:'新项目',sessionLease:'新会话',novelConfig:{}} as never});release(recovery)})
 expect(container!.textContent).not.toContain('林岚停下脚步。')
 expect([...container!.querySelectorAll('button')].some(item=>item.textContent==='继续原选区任务')).toBe(false)
})
