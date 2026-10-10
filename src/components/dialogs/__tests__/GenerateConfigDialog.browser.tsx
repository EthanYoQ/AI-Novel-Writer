import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import type { ProjectData } from '../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import { useLLMStore } from '../../../stores/llm-store'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import GenerateConfigDialog from '../GenerateConfigDialog'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const project: ProjectData = {
  id: 'config-prefill', name: 'Config prefill', path: 'C:\\synthetic\\config-prefill', sessionLease: 'config-prefill-lease',
  novelConfig: {
    genre: '奇幻', subGenre: '', targetAudience: '', totalChapters: 10, wordsPerChapter: 3000,
    plotStructure: 'three_act', narrativePOV: 'third_limited', coreOutline: '作者已有的核心大纲',
    worldSetting: '', goldenFinger: '', protagonistProfile: '', globalGuidance: '',
  }, characterStates: '', createdAt: '', updatedAt: '',
}
const originalProject = useProjectStore.getState()
const originalLLM = useLLMStore.getState()
const originalWorkflow = useWorkflowStore.getState()
const startWorkflow = vi.fn(async () => 'config-prefill-run')
const onClose = vi.fn()
const onGenerated = vi.fn()
let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.clearAllMocks()
  useProjectStore.setState({ currentProject: project })
  useLLMStore.setState({ defaultModelId: 'config-prefill-model' })
  useWorkflowStore.setState({ activeRuns: [], history: [], globalLogs: [], startWorkflow })
  setActiveProjectSessionContext({ projectId: project.id, projectPath: project.path, leaseId: 'config-prefill-lease' })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  setActiveProjectSessionContext(null)
  useProjectStore.setState(originalProject)
  useLLMStore.setState(originalLLM)
  useWorkflowStore.setState(originalWorkflow)
})

async function renderDialog(isOpen: boolean) {
  await act(async () => root.render(
    <GenerateConfigDialog isOpen={isOpen} onClose={onClose} onGenerated={onGenerated} />,
  ))
}

it('prefills the core outline as editable input and submits it once after expansion approval', async () => {
  await renderDialog(true)
  await expect.element(page.getByRole('textbox')).toHaveValue(project.novelConfig.coreOutline)
  const submit = page.getByRole('button', { name: '一键生成配置' })
  await expect.element(submit).toBeEnabled()
  await act(async () => {
    const button = submit.element()
    if (!(button instanceof HTMLButtonElement)) throw new Error('Expected generation button')
    button.click()
    button.click()
  })
  await expect.element(submit).toBeDisabled()
  await expect.element(page.getByRole('button', { name: '继续扩写' })).toBeVisible()
  expect(startWorkflow).not.toHaveBeenCalled()
  await act(async () => page.getByRole('button', { name: '继续扩写' }).click())
  await act(async () => vi.waitFor(() => expect(startWorkflow).toHaveBeenCalledOnce()))
  expect(startWorkflow).toHaveBeenCalledWith(expect.objectContaining({
    type: 'config_generation',
    projectPath: project.path,
  }))
  expect(onClose).toHaveBeenCalledOnce()
})

it('keeps edits during an open dialog and prefills the latest outline when reopened', async () => {
  await renderDialog(false)
  await renderDialog(true)
  const idea = page.getByRole('textbox')
  await act(async () => idea.fill('手动修改后的脑洞'))
  await act(async () => useProjectStore.setState({ currentProject: {
    ...project, novelConfig: { ...project.novelConfig, coreOutline: '打开期间更新的大纲', totalChapters: 20 },
  } }))
  await expect.element(idea).toHaveValue('手动修改后的脑洞')
  await renderDialog(false)
  await act(async () => useProjectStore.setState({ currentProject: {
    ...project, novelConfig: { ...project.novelConfig, coreOutline: '关闭后更新的大纲' },
  } }))
  await renderDialog(true)
  await expect.element(idea).toHaveValue('关闭后更新的大纲')
})

it('keeps generation disabled without an outline until a nonblank idea is entered', async () => {
  useProjectStore.setState({ currentProject: {
    ...project, novelConfig: { ...project.novelConfig, coreOutline: '' },
  } })
  await renderDialog(true)
  const idea = page.getByRole('textbox')
  const submit = page.getByRole('button', { name: '一键生成配置' })
  await expect.element(idea).toHaveValue('')
  await expect.element(submit).toBeDisabled()
  await act(async () => idea.fill('   '))
  await expect.element(submit).toBeDisabled()
  await act(async () => idea.fill('新的创作脑洞'))
  await expect.element(submit).toBeEnabled()
  expect(startWorkflow).not.toHaveBeenCalled()
})
