import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import WorldBuildingEditor from '../WorldBuildingEditor'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const session = { projectId: 'candidate-project', leaseId: 'candidate-lease', projectPath: 'C:\\synthetic\\candidate-project' }
const handle = { projectId: session.projectId, epoch: 'epoch-1', rootActionId: 'root-1', runId: 'run-1' }
let root: Root
let container: HTMLDivElement
let invoke: ReturnType<typeof vi.fn>
let copy: ReturnType<typeof vi.fn>
let partial: Record<string, unknown>
let composition: unknown
let readFails: boolean
let startWorkflow: ReturnType<typeof vi.fn>
const originalStart = useWorkflowStore.getState().startWorkflow
function button(label: string) {
  const result = [...container.querySelectorAll('button')].find(node => node.textContent?.includes(label))
  if (!result) throw new Error(`Missing button ${label}`)
  return result
}
beforeEach(() => {
  vi.clearAllMocks()
  partial = {}
  composition = null
  readFails = false
  startWorkflow = vi.fn().mockResolvedValue(undefined)
  useWorkflowStore.setState({ startWorkflow: startWorkflow as typeof originalStart, activeRuns: [], history: [], currentRun: null })
  useProjectStore.setState({ currentProject: { id: session.projectId, name: '候选测试', path: session.projectPath, sessionLease: session.leaseId, novelConfig: { genre: '', targetAudience: '', coreOutline: '真实合成测试核心设定'  } } as never })
  setActiveProjectSessionContext(session)
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'db:project-core-get') return { synopsis: '', worldbuilding: '', totalChapters: 20 }
    if (channel === 'fs:read-json') return { success: true, data: partial }
    if (channel === 'generation:read-visible-composition') {
      if (readFails) throw new Error('SOURCE_CHANGED')
      return composition
    }
    throw new Error(`Unexpected IPC ${channel}`)
  })
  Object.assign(window, { aiNovelAPI: { invoke, on: vi.fn(), once: vi.fn(), send: vi.fn() } })
  copy = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useWorkflowStore.setState({ startWorkflow: originalStart })
  setActiveProjectSessionContext(null)
  delete (window as typeof window & { aiNovelAPI?: unknown }).aiNovelAPI
})
async function render() {
  await act(async () => root.render(<WorldBuildingEditor projectKey={session.projectPath} />))
  await vi.waitFor(() => expect(container.textContent).toContain('未完成候选 · 未写入正式内容'))
}
describe('首次架构候选恢复', () => {
  for (const kind of ['synopsis', 'world_building'] as const) {
    it(`${kind} 首轮无正式内容可查看、逐字复制并续写确切已确认运行`, async () => {
      partial = { [`${kind}_incomplete`]: true, [`${kind}_generation_handle`]: handle }
      const text = '  首轮候选\n中文原文，尚未完成。\n'
      composition = { algorithm: 'visible-append-v1', text, textHash: 'a'.repeat(64), artifactIds: ['artifact-1'], sources: [] }
      await render()
      await act(async () => button('查看候选').click())
      expect(container.querySelector('pre')?.textContent).toBe(text)
      await act(async () => button('复制').click())
      expect(copy).toHaveBeenCalledWith(text)
      expect(button('断点续写').disabled).toBe(false)
      await act(async () => button('断点续写').click())
      expect(startWorkflow).toHaveBeenCalledOnce()
      const definition = startWorkflow.mock.calls[0][0]
      expect(definition.steps).toHaveLength(1)
      // Exercise the real launcher and factory: the displayed run cannot be replaced.
      partial[`${kind}_generation_handle`] = { ...handle, runId: 'different-run' }
      await expect(definition.steps[0].executor({}, {
        runId: 'resume', projectPath: session.projectPath, projectSession: session,
        writingLanguage: 'zh-CN', uiLocale: 'zh-CN', data: {}, cancelled: false,
      }, { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() })).rejects.toThrow('恢复记录已变化')
      expect(invoke.mock.calls.some(([channel]) => /commit|upsert|write|generation:execute/.test(channel))).toBe(false)
    })
    for (const state of ['no-handle', 'null', 'error'] as const) {
      it(`${kind} ${state} 镜像只可查看复制，不授权续写`, async () => {
        const text = '  旧候选原文\n'
        partial = { [`${kind}_incomplete`]: true, [kind === 'synopsis' ? 'synopsis_result' : 'world_building_partial_result']: text }
        if (state !== 'no-handle') partial[`${kind}_generation_handle`] = handle
        readFails = state === 'error'
        await render()
        expect(container.textContent).toContain('可查看或复制后重新生成')
        await act(async () => button('查看候选').click())
        expect(container.querySelector('pre')?.textContent).toBe(text)
        await act(async () => button('复制').click())
        expect(copy).toHaveBeenCalledWith(text)
        expect(button('断点续写').disabled).toBe(true)
        await act(async () => button('断点续写').click())
        expect(startWorkflow).not.toHaveBeenCalled()
      })
    }
  }
})
