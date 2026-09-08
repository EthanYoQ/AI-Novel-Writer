import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { CharacterCardImportButton } from '../CharacterCardImportButton'
import { useProjectStore } from '../../../stores/project-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useLLMStore } from '../../../stores/llm-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import type { ProjectData } from '../../../shared/ipc-channels'

const project = { id: 'paste', path: 'C:\\novels\\paste', sessionLease: 'lease-1' } as ProjectData
const model = { id: 'model', name: 'Test model', modelName: 'test', baseUrl: 'https://example.invalid' } as ReturnType<typeof useLLMStore.getState>['models'][number]
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const originals = { project: useProjectStore.getState(), locale: useLocaleStore.getState(), llm: useLLMStore.getState(), workflow: useWorkflowStore.getState() }
let root: Root
let container: HTMLDivElement
let start: ReturnType<typeof vi.fn<ReturnType<typeof useWorkflowStore.getState>['startWorkflow']>>
let invoke: ReturnType<typeof vi.fn>
let testLease = 0

function button(label: string) {
  const result = [...document.querySelectorAll('button')].find(node => node.textContent === label || node.getAttribute('aria-label') === label)
  expect(result, label).toBeTruthy()
  return result!
}
async function click(label: string) {
  await act(async () => button(label).click())
  // Existing confirmation dialogs resolve after their 200 ms exit animation.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)) })
}
async function paste(value: string) {
  await act(async () => page.getByRole('textbox', { name: '角色卡全文' }).fill(value))
}

beforeEach(async () => {
  vi.clearAllMocks()
  project.sessionLease = `lease-${++testLease}`
  invoke = vi.fn().mockResolvedValue(null)
  Object.defineProperty(window, 'velaAPI', { configurable: true, value: { invoke, on: vi.fn(() => () => {}), once: vi.fn(), send: vi.fn() } })
  start = vi.fn<ReturnType<typeof useWorkflowStore.getState>['startWorkflow']>().mockResolvedValue('failed-run')
  useLocaleStore.setState({ locale: 'zh-CN', initialized: true })
  useProjectStore.setState({ currentProject: project })
  setActiveProjectSessionContext({ projectId: project.id, projectPath: project.path, leaseId: project.sessionLease! })
  useLLMStore.setState({ models: [model], defaultModelId: model.id })
  useWorkflowStore.setState({ startWorkflow: start, history: [], getResourceConflict: () => null })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<CharacterCardImportButton projectKey={project.path} />))
  await click('粘贴 / 导入角色卡')
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(window, 'velaAPI')
  setActiveProjectSessionContext(null)
  useProjectStore.setState(originals.project)
  useLocaleStore.setState(originals.locale)
  useLLMStore.setState(originals.llm)
  useWorkflowStore.setState(originals.workflow)
})

describe('角色卡导入入口', () => {
  it('发送前需同意，取消同意后保留全文且不启动工作流', async () => {
    await paste('姓名：林舟\n背景：旧港调查员')
    await click('AI 提取并预览')
    expect(document.body.textContent).toContain(model.baseUrl)
    await click('取消')
    expect(start).not.toHaveBeenCalled()
    expect(document.querySelector('textarea')?.value).toContain('旧港调查员')
  })

  it('使用已有提取工作流与逐步确认，失败不丢失粘贴内容', async () => {
    await paste('姓名：林舟')
    await click('AI 提取并预览')
    await click('发送并提取')
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      generationModelId: model.id,
      projectSession: { projectId: project.id, projectPath: project.path, leaseId: project.sessionLease },
      steps: [expect.objectContaining({ name: '生成待确认角色卡' }), expect.objectContaining({ name: '确认并导入角色卡' })],
    }), true)
    expect(document.querySelector('textarea')?.value).toBe('姓名：林舟')
  })

  it('没有模型时给出设置指引并保留输入', async () => {
    useLLMStore.setState({ models: [], defaultModelId: null })
    await paste('姓名：林舟')
    await click('AI 提取并预览')
    expect(document.body.textContent).toContain('模型配置')
    expect(start).not.toHaveBeenCalled()
    expect(document.querySelector('textarea')?.value).toBe('姓名：林舟')
  })

  it('导航离开后确认取消，仍恢复粘贴内容和已选文件', async () => {
    invoke.mockImplementation((channel: string) => Promise.resolve(channel === 'dialog:select-knowledge-files'
      ? [{ grantId: 'grant', displayName: '角色.txt' }]
      : { success: true, content: '姓名：林舟' }))
    await paste('姓名：江澜')
    await click('选择文件')
    await click('AI 提取并预览')
    await act(async () => root.unmount())
    await click('取消')
    root = createRoot(container)
    await act(async () => root.render(<CharacterCardImportButton projectKey={project.path} />))
    await click('粘贴 / 导入角色卡')
    expect(document.querySelector('textarea')?.value).toBe('姓名：江澜')
    expect(document.body.textContent).toContain('角色.txt')
  })

  it('文件读取期间同路径项目重新打开，不将旧文件带入新会话', async () => {
    let resolve!: (result: { success: true; content: string }) => void
    invoke.mockImplementation((channel: string) => channel === 'dialog:select-knowledge-files'
      ? Promise.resolve([{ grantId: 'grant', displayName: '旧项目私有角色.txt' }])
      : new Promise(done => { resolve = done }))
    await click('选择文件')
    await act(async () => {
      setActiveProjectSessionContext({ projectId: project.id, projectPath: project.path, leaseId: 'lease-2' })
      useProjectStore.setState({ currentProject: { ...project, sessionLease: 'lease-2' } })
      resolve({ success: true, content: '旧项目内容' })
    })
    await click('粘贴 / 导入角色卡')
    expect(document.body.textContent).not.toContain('旧项目私有角色.txt')
    expect(document.querySelector('textarea')?.value).toBe('')
    expect(start).not.toHaveBeenCalled()
  })

  it('文件选择只读取授权文件，不自动发送；提取成功后清空临时输入', async () => {
    invoke.mockImplementation((channel: string) => Promise.resolve(channel === 'dialog:select-knowledge-files'
      ? [{ grantId: 'grant', displayName: '角色.txt' }]
      : { success: true, content: '姓名：林舟' }))
    await click('选择文件')
    expect(document.body.textContent).toContain('角色.txt')
    expect(start).not.toHaveBeenCalled()
    start.mockImplementation(async () => {
      useWorkflowStore.setState({ history: [{ id: 'ok', status: 'completed' } as ReturnType<typeof useWorkflowStore.getState>['history'][number]] })
      return 'ok'
    })
    await click('AI 提取并预览')
    await click('发送并提取')
    expect(start).toHaveBeenCalledOnce()
    await act(async () => root.unmount())
    root = createRoot(container)
    await act(async () => root.render(<CharacterCardImportButton projectKey={project.path} />))
    await click('粘贴 / 导入角色卡')
    expect(document.body.textContent).not.toContain('角色.txt')
    expect(document.querySelector('textarea')?.value).toBe('')
  })
})
