import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'

import { useLayoutStore } from '../../../stores/layout-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore, type WorkflowRun } from '../../../stores/workflow-store'
import ShellV2 from '../../layout/v2/ShellV2'
import BottomPanel from '../BottomPanel'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const originalLayout = useLayoutStore.getState()
const originalLocale = useLocaleStore.getState()
const originalProject = useProjectStore.getState()
const originalWorkflow = useWorkflowStore.getState()
let root: Root | undefined
let host: HTMLDivElement | undefined

const project = (path: string) => ({ id: path, path, name: path, sessionLease: `lease-${path}`, novelConfig: {} }) as never
const run = (id: string, projectPath: string, status: 'running' | 'completed'): WorkflowRun => ({
  id, projectPath, projectSession: null, writingLanguage: 'zh-CN', uiLocale: 'zh-CN',
  type: 'chapter_creation', title: `${id}标题`, status, currentStepIndex: 0,
  createdAt: '2026-09-22T00:00:00.000Z',
  steps: [{ id: `${id}-step`, name: `${id}步骤`, description: '生成正文', status, result: `${id}正文`, logs: [] }],
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  useLayoutStore.setState(originalLayout, true)
  useLocaleStore.setState(originalLocale, true)
  useProjectStore.setState(originalProject, true)
  useWorkflowStore.setState(originalWorkflow, true)
})

it('V3 底部任务区只显示当前项目任务，切回可见且取消只作用 B', async () => {
  const aHistory = run('A已完成', 'C:/v3/A', 'completed')
  const aActive = run('A遗留', 'C:/v3/A', 'running')
  const bActive = run('B当前', 'C:/v3/B', 'running')
  const cancelWorkflow = vi.fn()
  useLayoutStore.setState({ bottomPanelOpen: true, bottomTab: 'tasks' })
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({ currentProject: project('C:/v3/A') })
  useWorkflowStore.setState({ activeRuns: [aActive], history: [aHistory], waitingRuns: {}, cancelWorkflow })
  host = document.createElement('div')
  host.style.width = '1440px'
  host.style.height = '900px'
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root?.render(
    <ShellV2 presentation="writer" variant="v3" theme="paper" titleBar={<span>V3</span>}
      rail={<span>小说</span>} sidebar={<span>作品资料</span>} editor={<span>正文</span>}
      aiPanel={<span>AI 输出</span>} bottom={<BottomPanel />} statusBar={<span>本地写作</span>} />,
  ))
  const bottom = () => host!.querySelector('.writer-task-table')!
  expect(bottom().textContent).toContain('A已完成标题')
  expect(bottom().textContent).toContain('A遗留步骤')

  await act(async () => {
    useProjectStore.setState({ currentProject: project('C:/v3/B') })
    useWorkflowStore.setState({ activeRuns: [aActive, bActive] })
  })
  expect(bottom().textContent).not.toContain('A已完成标题')
  expect(bottom().textContent).not.toContain('A遗留步骤')
  expect(bottom().textContent).toContain('B当前步骤')
  expect(bottom().querySelector('div.no-select')?.textContent).toBe('任务1')
  const cancel = bottom().querySelector<HTMLButtonElement>('button[title="取消任务"]')!
  await act(async () => cancel.click())
  expect(cancelWorkflow).toHaveBeenCalledExactlyOnceWith('B当前')

  await act(async () => useProjectStore.setState({ currentProject: project('C:/v3/A') }))
  expect(bottom().textContent).toContain('A已完成标题')
  expect(bottom().textContent).toContain('A遗留步骤')
  expect(bottom().textContent).not.toContain('B当前步骤')

  await act(async () => useProjectStore.setState({ currentProject: null }))
  expect(bottom().textContent).not.toContain('A已完成标题')
  expect(bottom().textContent).not.toContain('A遗留步骤')
  expect(bottom().textContent).not.toContain('B当前步骤')
  expect(bottom().textContent).toContain('暂无任务')
  expect(bottom().querySelector('div.no-select')?.textContent).toBe('任务')
})
