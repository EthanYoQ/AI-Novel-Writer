import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import PromptSettings from '../PromptSettings'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  useProjectStore.setState({ currentProject: null })
  useLocaleStore.setState({ locale: 'zh-CN' })
})

it('checks project prompt diagnostics for the language selected in settings', async () => {
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'prompt:load-global') throw new Error('global unavailable in project diagnostic fixture')
    if (channel === 'fs:check-exists') return true
    if (channel === 'fs:list-dir') return [{
      name: 'premise.zh-CN.json',
      path: 'C:/novels/english/.vela/prompts/premise.zh-CN.json',
      isDir: false,
    }]
    if (channel === 'fs:read-file') return { success: true, content: '{invalid json' }
    throw new Error(`Unexpected IPC channel: ${channel}`)
  })
  ;(window as unknown as { velaAPI: { invoke: typeof invoke } }).velaAPI = { invoke }
  useLocaleStore.setState({ locale: 'en-US' })
  useProjectStore.setState({
    currentProject: {
      id: 'english-project',
      name: 'English Project',
      path: 'C:/novels/english',
      sessionLease: 'lease-english',
      novelConfig: { writingLanguage: 'en-US' },
    } as never,
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => { root?.render(<PromptSettings />) })

  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(
    'fs:read-file',
    expect.anything(),
    expect.anything(),
    expect.anything(),
  ))
  await expect.element(page.getByText(/Project prompts could not be loaded/)).not.toBeInTheDocument()

  await act(async () => page.getByRole('combobox', { name: 'Writing language to edit' }).selectOptions('zh-CN'))
  await expect.element(page.getByText(/Project prompts could not be loaded/)).toBeVisible()
})

it('keeps the project error visible when a later global retry succeeds', async () => {
  let globalAttempt = 0
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'prompt:load-global') {
      globalAttempt += 1
      if (globalAttempt === 1) throw new Error('global denied')
      return { templates: [], diagnostics: [] }
    }
    if (channel === 'fs:check-exists' && String(args[0]).endsWith('/.vela/prompts')) {
      throw new Error('project denied')
    }
    throw new Error(`Unexpected IPC channel: ${channel}`)
  })
  ;(window as unknown as { velaAPI: { invoke: typeof invoke } }).velaAPI = { invoke }

  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({
    currentProject: {
      id: 'project-a',
      name: 'Project A',
      path: 'C:/novels/project-a',
      sessionLease: 'lease-a',
      novelConfig: {},
    } as never,
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => { root?.render(<PromptSettings />) })

  await expect.element(page.getByText(/全局提示词加载失败/)).toBeVisible()
  await expect.element(page.getByText(/项目提示词加载失败/)).toBeVisible()

  await act(async () => { root?.render(<></>) })
  await act(async () => { root?.render(<PromptSettings />) })
  await vi.waitFor(() => expect(globalAttempt).toBeGreaterThan(1))
  await expect.element(page.getByText(/项目提示词加载失败/)).toBeVisible()
})
