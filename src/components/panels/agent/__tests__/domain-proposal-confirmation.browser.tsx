import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { useLocaleStore } from '../../../../stores/locale-store'
import { useProjectStore } from '../../../../stores/project-store'
import { useAgentStore } from '../../../../stores/agent-store'
import ConfirmCard from '../ConfirmCard'

const resolveToolConfirmation = vi.fn()
const cancelGeneration = vi.fn()
const invoke = vi.fn()

const session = { projectId: 'A', leaseId: 'lease-A', projectPath: 'C:\\novels\\A' }
const project = {
  id: 'A', sessionLease: 'lease-A', path: session.projectPath, name: 'A', characterStates: '', createdAt: '', updatedAt: '',
  novelConfig: {
    genre: '奇幻', subGenre: '', targetAudience: '青年', totalChapters: 10, wordsPerChapter: 3000,
    plotStructure: 'three_act', narrativePOV: 'third_limited', coreOutline: '旧大纲', worldSetting: '',
    goldenFinger: '', protagonistProfile: '', globalGuidance: '',
  },
}

let container: HTMLDivElement
let root: Root
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  resolveToolConfirmation.mockReset()
  cancelGeneration.mockReset()
  invoke.mockReset()
  useAgentStore.setState({ resolveToolConfirmation, cancelGeneration })
  useProjectStore.setState({ currentProject: project as never })
  Object.defineProperty(window, 'velaAPI', {
    configurable: true,
    value: {
      invoke: invoke,
      on: vi.fn(), once: vi.fn(), send: vi.fn(),
      setZoomLevel: vi.fn(), setZoomFactor: vi.fn(), getZoomLevel: vi.fn(),
    },
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useProjectStore.setState({ currentProject: null })
})

describe('Agent domain proposal confirmation', () => {
  it('shows an English field diff instead of raw tool JSON and approves the existing gate', async () => {
    useLocaleStore.setState({ locale: 'en-US', initialized: true })
    await act(async () => root.render(<ConfirmCard toolCall={{
      id: 'config-1', toolName: 'propose_novel_config', arguments: { changes: { genre: 'Science fiction' } },
      status: 'waiting_confirm', source: 'builtin', projectSession: session,
    }} />))

    await expect.element(page.getByText('Genre')).toBeVisible()
    await expect.element(page.getByText('Current')).toBeVisible()
    await expect.element(page.getByText('奇幻')).toBeVisible()
    await expect.element(page.getByText('Science fiction')).toBeVisible()
    expect(container.textContent).not.toContain('"changes"')
    await page.getByRole('button', { name: 'Approve' }).click()
    expect(resolveToolConfirmation).toHaveBeenCalledWith('config-1', true)
  })

  it('loads a Chinese blueprint diff and rejects without invoking a write', async () => {
    useLocaleStore.setState({ locale: 'zh-CN', initialized: true })
    invoke.mockResolvedValue({
      chapterNumber: 2, title: '旧标题', role: '发展', purpose: '推进调查', keyEvents: '找到线索',
      characters: ['林舟'], suspenseHook: '谁在说谎', userGuidance: '', notes: '', notesUpdatedAt: '',
    })
    await act(async () => root.render(<ConfirmCard toolCall={{
      id: 'blueprint-1', toolName: 'propose_chapter_blueprint',
      arguments: { chapter_number: 2, changes: { title: '新标题' } },
      status: 'waiting_confirm', source: 'builtin', projectSession: session,
    }} />))

    await expect.element(page.getByText('章节标题')).toBeVisible()
    await expect.element(page.getByText('旧标题')).toBeVisible()
    await expect.element(page.getByText('新标题')).toBeVisible()
    await page.getByRole('button', { name: '拒绝' }).click()
    expect(resolveToolConfirmation).toHaveBeenCalledWith('blueprint-1', false)
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('disables approval after a project switch', async () => {
    useLocaleStore.setState({ locale: 'en-US', initialized: true })
    useProjectStore.setState({ currentProject: { ...project, id: 'B', sessionLease: 'lease-B', path: 'C:\\novels\\B' } as never })
    await act(async () => root.render(<ConfirmCard toolCall={{
      id: 'stale-1', toolName: 'propose_novel_config', arguments: { changes: { genre: 'Mystery' } },
      status: 'waiting_confirm', source: 'builtin', projectSession: session,
    }} />))
    await expect.element(page.getByText(/proposal is stale/)).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Approve' })).toBeDisabled()
  })

  it('cancels the whole Agent task without executing a domain write', async () => {
    useLocaleStore.setState({ locale: 'en-US', initialized: true })
    await act(async () => root.render(<ConfirmCard toolCall={{
      id: 'cancel-1', toolName: 'propose_novel_config', arguments: { changes: { genre: 'Mystery' } },
      status: 'waiting_confirm', source: 'builtin', projectSession: session,
    }} />))
    await page.getByRole('button', { name: 'Cancel this Agent task' }).click()
    expect(cancelGeneration).toHaveBeenCalledOnce()
    expect(resolveToolConfirmation).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
  })
})
