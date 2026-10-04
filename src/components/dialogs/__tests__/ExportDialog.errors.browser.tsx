import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'

import type { ProjectData } from '../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import ExportDialog from '../ExportDialog'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const project: ProjectData = {
  id: 'export-dialog-project',
  name: '导出测试项目',
  path: 'C:\\novels\\export-dialog-project',
  sessionLease: 'export-dialog-lease',
  novelConfig: {
    genre: '奇幻', subGenre: '', targetAudience: '通用', totalChapters: 1, wordsPerChapter: 1000,
    plotStructure: 'three_act', narrativePOV: 'third_limited', coreOutline: '', worldSetting: '',
    goldenFinger: '', protagonistProfile: '', globalGuidance: '', writingLanguage: 'zh-CN',
  },
  characterStates: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

let root: Root
let container: HTMLDivElement
let invoke: ReturnType<typeof vi.fn>
const originalWorkflow = useWorkflowStore.getState()

beforeEach(() => {
  vi.clearAllMocks()
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({ currentProject: project })
  setActiveProjectSessionContext({ projectId: project.id, projectPath: project.path, leaseId: project.sessionLease! })
  invoke = vi.fn().mockResolvedValue({ grantId: 'export-grant', displayName: '导出目录' })
  Object.defineProperty(window, 'aiNovelAPI', {
    configurable: true,
    value: { invoke, on: vi.fn(() => () => {}), once: vi.fn(), send: vi.fn() },
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(window, 'aiNovelAPI')
  setActiveProjectSessionContext(null)
  useProjectStore.setState({ currentProject: null })
  useWorkflowStore.setState(originalWorkflow)
})

async function renderDialog() {
  await act(async () => root.render(<ExportDialog isOpen onClose={vi.fn()} />))
}

describe('ExportDialog failure handling', () => {
  it('shows a retryable picker failure without entering exporting', async () => {
    invoke.mockRejectedValueOnce(new Error('picker unavailable'))
    await renderDialog()

    await act(async () => page.getByRole('button', { name: '选择目录并导出' }).click())

    await expect.element(page.getByText('选择导出目录失败，请重试。')).toBeVisible()
    await expect.element(page.getByRole('button', { name: '选择目录并导出' })).toBeEnabled()
    expect(invoke).toHaveBeenCalledOnce()
  })

  it('shows a retryable export rejection without an unhandled promise', async () => {
    useWorkflowStore.setState({ addLog: undefined as never })
    await renderDialog()

    await act(async () => page.getByRole('button', { name: '选择目录并导出' }).click())

    await expect.element(page.getByText('导出失败，请重试。')).toBeVisible()
    await expect.element(page.getByRole('button', { name: '选择目录并导出' })).toBeEnabled()
  })

  it('preserves exportNovel success and failure results', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'dialog:select-export-directory') return { grantId: 'export-grant', displayName: '导出目录' }
      if (channel === 'db:draft-export-snapshot') return [{
        draftId: 1, chapterNumber: 1, version: 1, title: '第一章', content: '正文',
        finalizationId: 'finalization-1', contentHash: 'a'.repeat(64),
      }]
      if (channel === 'db:project-core-get') return { synopsis: '' }
      if (channel === 'db:draft-export-authority-current') return true
      if (channel === 'fs:grant-write-file') return { success: true }
      return { success: true }
    })
    await renderDialog()
    await act(async () => page.getByRole('button', { name: '选择目录并导出' }).click())
    await expect.element(page.getByText('已导出到：导出目录/导出测试项目.md')).toBeVisible()

    await act(async () => root.render(<ExportDialog isOpen onClose={vi.fn()} />))
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'dialog:select-export-directory') return { grantId: 'export-grant', displayName: '导出目录' }
      if (channel === 'db:draft-export-snapshot') return [{
        draftId: 1, chapterNumber: 1, version: 1, title: '第一章', content: '正文',
        finalizationId: 'finalization-1', contentHash: 'a'.repeat(64),
      }]
      if (channel === 'db:project-core-get') return { synopsis: '' }
      if (channel === 'db:draft-export-authority-current') return true
      if (channel === 'fs:grant-write-file') return { success: false, commitState: 'not_committed', error: '磁盘空间不足' }
      return { success: true }
    })
    await act(async () => page.getByRole('button', { name: '选择目录并导出' }).click())
    await expect.element(page.getByText(/磁盘空间不足/)).toBeVisible()
  })

  it('does not report success after the picker session expires', async () => {
    let resolvePicker!: (value: { grantId: string; displayName: string }) => void
    invoke.mockReturnValueOnce(new Promise(resolve => { resolvePicker = resolve }))
    await renderDialog()

    await act(async () => {
      const click = page.getByRole('button', { name: '选择目录并导出' }).click()
      setActiveProjectSessionContext(null)
      resolvePicker({ grantId: 'stale-grant', displayName: '过期目录' })
      await click
    })

    expect(invoke.mock.calls.some(([channel]) => channel === 'fs:grant-write-file')).toBe(false)
    expect(document.body.textContent).not.toContain('已导出到：')
  })
})
