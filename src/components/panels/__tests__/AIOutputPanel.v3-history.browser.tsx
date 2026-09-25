import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import '../../../index.css'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore, type WorkflowRun } from '../../../stores/workflow-store'
import ShellV2 from '../../layout/v2/ShellV2'
import AIOutputPanel from '../AIOutputPanel'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const originalWorkflow = useWorkflowStore.getState()
const originalProject = useProjectStore.getState()
const originalBridge = Object.getOwnPropertyDescriptor(window, 'aiNovelAPI')
let root: Root | undefined
let host: HTMLDivElement | undefined

const project = (path: string) => ({ id: path, path, name: path, sessionLease: `lease-${path}`, novelConfig: {} }) as never
const run = (id: string, status: 'running' | 'completed', body: string, projectPath = 'C:/v3/history'): WorkflowRun => ({
  id, projectPath, projectSession: null, writingLanguage: 'zh-CN', uiLocale: 'zh-CN',
  type: 'chapter_creation', title: `写稿 - 第 1 章：${id}`, status, currentStepIndex: 0,
  createdAt: '2026-09-22T00:00:00.000Z',
  steps: [{ id: `${id}-step`, name: '写稿', description: '生成正文', status, result: body, logs: [] }],
})

beforeEach(() => {
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: {
    invoke: async (channel: string) => {
      if (['db:recovery-candidate-list', 'generation:list', 'generation:list-batches'].includes(channel)) return []
      throw new Error(`Unexpected IPC: ${channel}`)
    },
    on: () => () => {},
  } })
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  useWorkflowStore.setState(originalWorkflow, true)
  useProjectStore.setState(originalProject, true)
  if (originalBridge) Object.defineProperty(window, 'aiNovelAPI', originalBridge)
  else Reflect.deleteProperty(window, 'aiNovelAPI')
})

it('V3 可在当前生成中选择旧历史正文及终态，再返回取消入口', async () => {
  const active = run('当前章', 'running', '当前正在生成。')
  const previous = run('旧章', 'completed', '旧章已保存的正文。')
  useProjectStore.setState({ currentProject: project('C:/v3/history') })
  useWorkflowStore.setState({ activeRuns: [active], history: [previous], currentRun: active })
  host = document.createElement('div')
  host.style.height = '900px'
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root?.render(
    <ShellV2 theme="paper" titleBar={<span>V3</span>}
      rail={<span>小说</span>} sidebar={<span>作品资料</span>} editor={<span>正文</span>}
      aiPanel={<AIOutputPanel />} bottom={<span>任务</span>} statusBar={<span>本地写作</span>} />,
  ))
  expect(host.querySelector('[data-shell-variant="v3"]')).not.toBeNull()
  expect(host.textContent).toContain('中止生成')
  const button = (label: string) => [...(host?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    .find(item => item.textContent?.includes(label))
  expect(button('旧章')).toBeDefined()
  await act(async () => button('旧章')?.click())
  expect(host.textContent).toContain('旧章已保存的正文。')
  expect(host.textContent).toContain('整个工作流已全部完成')
  await act(async () => button('当前生成')?.click())
  expect(host.textContent).toContain('当前正在生成。')
  expect(host.textContent).toContain('中止生成')
})

it('V3 切换到 B 项目后不展示 A 项目历史或已选正文', async () => {
  const previous = run('A的私密章节', 'completed', 'A专属正文。', 'C:/v3/A')
  const active = run('B当前生成', 'running', 'B的正文。', 'C:/v3/B')
  useProjectStore.setState({ currentProject: project('C:/v3/A') })
  useWorkflowStore.setState({ activeRuns: [], history: [previous], currentRun: null })
  host = document.createElement('div')
  host.style.height = '900px'
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root?.render(
    <ShellV2 theme="paper" titleBar={<span>V3</span>}
      rail={<span>小说</span>} sidebar={<span>作品资料</span>} editor={<span>正文</span>}
      aiPanel={<AIOutputPanel />} bottom={<span>任务</span>} statusBar={<span>本地写作</span>} />,
  ))
  const button = (label: string) => [...(host?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    .find(item => item.textContent?.includes(label))
  await act(async () => button('A的私密章节')?.click())
  expect(host.textContent).toContain('A专属正文。')

  await act(async () => {
    useProjectStore.setState({ currentProject: project('C:/v3/B') })
    useWorkflowStore.setState({ activeRuns: [active], currentRun: active })
  })
  await vi.waitFor(() => expect(host?.textContent).toContain('中止生成'))
  expect(host.textContent).toContain('B的正文。')
  expect(host.textContent).not.toContain('A的私密章节')
  expect(host.textContent).not.toContain('A专属正文。')
  expect(button('A的私密章节')).toBeUndefined()

  await act(async () => useProjectStore.setState({ currentProject: null }))
  expect(host.textContent).not.toContain('B的正文。')
  expect(host.textContent).not.toContain('中止生成')
})

it('V3 1440×900 的持久正文候选文字按钮不竖排或溢出', async () => {
  const current = project('C:/v3/candidate')
  const handle = { projectId: 'C:/v3/candidate', epoch: 'lease-C:/v3/candidate', rootActionId: 'candidate-root', runId: 'candidate-run' }
  const view = { handle, status: 'completed', artifacts: [{ ...handle, artifactId: 'candidate-text', attemptId: 'attempt-1',
    text: '候选正文。', status: 'completed', compositionEligible: true }], candidates: [] }
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: {
    invoke: async (channel: string) => {
      if (channel === 'generation:list') return [view]
      if (channel === 'generation:list-batches' || channel === 'db:recovery-candidate-list') return []
      if (channel === 'generation:read-context') return { handle, operation: 'chapter-draft', chapterNumber: 1, composition: null }
      throw new Error(`Unexpected IPC: ${channel}`)
    },
    on: () => () => {},
  } })
  useProjectStore.setState({ currentProject: current })
  useWorkflowStore.setState({ activeRuns: [], history: [], currentRun: null })
  host = document.createElement('div')
  host.style.width = '1440px'
  host.style.height = '900px'
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root?.render(
    <ShellV2 theme="paper" titleBar={<span>V3</span>}
      rail={<span>小说</span>} sidebar={<span>作品资料</span>} editor={<span>正文</span>}
      aiPanel={<AIOutputPanel />} bottom={<span>任务</span>} statusBar={<span>本地写作</span>} />,
  ))
  await vi.waitFor(() => expect(host?.querySelector('section[aria-label="持久正文候选"]')).not.toBeNull())
  const buttons = [...host!.querySelectorAll<HTMLButtonElement>('section[aria-label="持久正文候选"] button')]
  expect(buttons.map(button => button.textContent?.trim())).toContain('确认继续已选正文')
  for (const button of buttons) {
    expect(button.scrollWidth, button.textContent ?? '').toBeLessThanOrEqual(button.clientWidth)
    expect(button.scrollHeight, button.textContent ?? '').toBeLessThanOrEqual(button.clientHeight)
  }
})
