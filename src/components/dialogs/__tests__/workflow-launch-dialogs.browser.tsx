import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import ArchitectureConfirmDialog from '../ArchitectureConfirmDialog'
import DirectoryConfigDialog from '../DirectoryConfigDialog'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement
let invoke: ReturnType<typeof vi.fn>
let authoritativeNextChapter: number
let authorityGap: number | null
let blueprintChapterNumbers: number[]

const project = {
  id: 'dialogs', sessionLease: 'lease-dialogs', name: 'Dialogs', path: 'C:\\novels\\dialogs',
  novelConfig: {
    genre: '奇幻', subGenre: '', targetAudience: '', totalChapters: 10, wordsPerChapter: 3000,
    plotStructure: 'three_act', narrativePOV: 'third_limited', coreOutline: '完整的故事构想',
    worldSetting: '', goldenFinger: '', protagonistProfile: '', globalGuidance: '',
  },
}

beforeEach(() => {
  authoritativeNextChapter = 1
  authorityGap = null
  blueprintChapterNumbers = []
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({ currentProject: project as never })
  useWorkflowStore.setState({
    activeRuns: [], history: [], globalLogs: [], waitingRuns: {}, currentRun: null,
    waitingForConfirm: false, waitingAfterStepIndex: -1,
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'db:blueprint-character-sync-list-pending') return []
    if (channel === 'db:blueprint-get-all') {
      return blueprintChapterNumbers.map(chapterNumber => ({ chapterNumber }))
    }
    if (channel === 'db:draft-authority-sequence') return authorityGap === null
      ? {
          status: authoritativeNextChapter === 1 ? 'empty' : 'continuous',
          lastChapterNumber: authoritativeNextChapter - 1,
          nextChapterNumber: authoritativeNextChapter,
          duplicateChapterNumbers: [],
          authorityFingerprint: 'a'.repeat(64),
        }
      : {
          status: 'invalid',
          lastChapterNumber: 9,
          firstGapChapterNumber: authorityGap,
          duplicateChapterNumbers: [],
          authorityFingerprint: 'b'.repeat(64),
        }
    return { success: true }
  })
  Object.defineProperty(window, 'velaAPI', {
    configurable: true,
    value: {
      invoke,
      on: vi.fn(() => () => {}),
      once: vi.fn(),
      send: vi.fn(),
      setZoomLevel: vi.fn(),
      setZoomFactor: vi.fn(),
      getZoomLevel: vi.fn(() => 0),
    },
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useProjectStore.setState({ currentProject: null })
  Reflect.deleteProperty(window, 'velaAPI')
})

describe('workflow launch dialogs', () => {
  it('does not mistake an active batch-writing task for blueprint generation', async () => {
    useWorkflowStore.setState({
      activeRuns: [{
        id: 'active-batch-writing',
        projectPath: project.path,
        projectSession: {
          projectId: project.id,
          leaseId: project.sessionLease,
          projectPath: project.path,
        },
        type: 'batch_generate',
        title: '批量创作',
        status: 'running',
        currentStepIndex: 0,
        createdAt: new Date().toISOString(),
        writingLanguage: 'zh-CN',
        uiLocale: 'zh-CN',
        resourceKeys: ['chapter:1'],
        steps: [],
      }],
    })
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    await act(async () => root.render(
      <DirectoryConfigDialog isOpen onClose={vi.fn()} existingCount={0} onConfirm={onConfirm} />,
    ))

    await act(async () => page.getByRole('button', { name: '开始生成' }).click())

    await vi.waitFor(() => expect(onConfirm).toHaveBeenCalledOnce())
  })

  it('defaults blueprint append generation to Chapter 10 after imported finalized Chapters 1 through 9', async () => {
    authoritativeNextChapter = 10
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    await act(async () => root.render(
      <DirectoryConfigDialog
        isOpen
        onClose={vi.fn()}
        existingCount={0}
        onConfirm={onConfirm}
      />,
    ))

    await expect.element(page.getByText(/从第 10 章起往后生成/)).toBeVisible()
    await act(async () => page.getByRole('button', { name: '开始生成' }).click())

    await vi.waitFor(() => expect(onConfirm).toHaveBeenCalledOnce())
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'append',
      startChapter: 10,
      count: 1,
    }))
  })

  it('appends after existing blueprints when finalized manuscript authority is behind', async () => {
    authoritativeNextChapter = 1
    blueprintChapterNumbers = [1, 2, 3, 4]
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    await act(async () => root.render(
      <DirectoryConfigDialog
        isOpen
        onClose={vi.fn()}
        existingCount={4}
        onConfirm={onConfirm}
      />,
    ))

    await expect.element(page.getByText(/从第 5 章起往后生成/)).toBeVisible()
    await act(async () => page.getByRole('spinbutton').nth(0).fill('4'))
    await act(async () => page.getByRole('button', { name: '开始生成' }).click())

    await vi.waitFor(() => expect(onConfirm).toHaveBeenCalledOnce())
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'append',
      startChapter: 5,
      count: 4,
    }))
  })

  it('appends after the highest existing blueprint when chapter numbers are non-consecutive', async () => {
    authoritativeNextChapter = 1
    blueprintChapterNumbers = [1, 3, 4]
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    await act(async () => root.render(
      <DirectoryConfigDialog
        isOpen
        onClose={vi.fn()}
        existingCount={3}
        onConfirm={onConfirm}
      />,
    ))

    await expect.element(page.getByText(/从第 5 章起往后生成/)).toBeVisible()
    await act(async () => page.getByRole('button', { name: '开始生成' }).click())

    await vi.waitFor(() => expect(onConfirm).toHaveBeenCalledOnce())
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'append',
      startChapter: 5,
    }))
  })

  it('blocks blueprint generation when finalized authority has a gap', async () => {
    authorityGap = 4
    const onConfirm = vi.fn()
    await act(async () => root.render(
      <DirectoryConfigDialog
        isOpen
        onClose={vi.fn()}
        existingCount={0}
        onConfirm={onConfirm}
      />,
    ))

    await expect.element(page.getByText(/权威定稿缺少第 4 章/)).toBeVisible()
    await expect.element(page.getByRole('button', { name: '开始生成' })).toBeDisabled()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('keeps architecture confirmation open and reports launcher rejection', async () => {
    const onClose = vi.fn()
    await act(async () => root.render(
      <ArchitectureConfirmDialog
        isOpen
        onClose={onClose}
        archStatus={{ premise: false, characters: false, worldbuilding: false, synopsis: false }}
        initialSelectedSteps={['premise']}
        onConfirm={vi.fn().mockRejectedValue(new Error('架构启动被领域门禁拒绝'))}
      />,
    ))

    await act(async () => page.getByRole('button', { name: /确认生成/ }).click())

    await expect.element(page.getByText('架构启动被领域门禁拒绝')).toBeVisible()
    expect(onClose).not.toHaveBeenCalled()
    await expect.element(page.getByRole('dialog')).toBeVisible()
  })

  it('restores missing architecture steps after the controlled dialog closes and reopens', async () => {
    const onClose = vi.fn()
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    const renderDialog = async (isOpen: boolean) => act(async () => root.render(
      <ArchitectureConfirmDialog
        isOpen={isOpen}
        onClose={onClose}
        archStatus={{ premise: false, characters: false, worldbuilding: false, synopsis: false }}
        onConfirm={onConfirm}
      />,
    ))

    await renderDialog(true)
    const charactersRow = Array.from(document.querySelectorAll('label'))
      .find(label => label.textContent?.includes('角色图谱'))
    expect(charactersRow).toBeDefined()
    await act(async () => charactersRow?.click())
    await expect.element(page.getByRole('button', { name: '确认生成（3/4）' })).toBeVisible()

    await act(async () => page.getByRole('button', { name: '取消' }).click())
    await renderDialog(false)
    await renderDialog(true)

    await expect.element(page.getByRole('button', { name: '确认生成（4/4）' })).toBeVisible()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('keeps directory configuration open and reports launcher rejection', async () => {
    const onClose = vi.fn()
    await act(async () => root.render(
      <DirectoryConfigDialog
        isOpen
        onClose={onClose}
        existingCount={0}
        onConfirm={vi.fn().mockRejectedValue(new Error('故事前提尚未生成'))}
      />,
    ))

    await expect.element(page.getByText(/预计至少 1 次模型调用/)).toBeVisible()

    await act(async () => page.getByRole('button', { name: '开始生成' }).click())

    await expect.element(page.getByText('故事前提尚未生成')).toBeVisible()
    expect(onClose).not.toHaveBeenCalled()
    await expect.element(page.getByRole('dialog')).toBeVisible()
  })

  it('shows and completes a durable character-sync repair without launching generation', async () => {
    let pending = true
    const operation = {
      operationId: 'blueprint-sync-directory-restart',
      blueprintCommitOperationId: 'directory-restart',
      blueprintCommitPayloadHash: 'a'.repeat(64),
      status: 'pending' as const,
      startChapter: 1,
      endChapter: 2,
      characterSyncInput: [],
      createdAt: '2026-01-01 00:00:00',
      updatedAt: '2026-01-01 00:00:00',
    }
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'db:blueprint-get-all') return []
      if (channel === 'db:draft-authority-sequence') return {
        status: 'empty',
        lastChapterNumber: 0,
        nextChapterNumber: 1,
        duplicateChapterNumbers: [],
        authorityFingerprint: 'c'.repeat(64),
      }
      if (channel === 'db:blueprint-character-sync-list-pending') return pending ? [operation] : []
      if (channel === 'db:blueprint-character-sync-get') return operation
      if (channel === 'db:blueprint-character-sync-complete') {
        pending = false
        return {
          success: true,
          operation: {
            ...operation,
            status: 'completed',
            completionReceipt: args[1],
          },
        }
      }
      return { success: true }
    })
    const onConfirm = vi.fn()
    await act(async () => root.render(
      <DirectoryConfigDialog
        isOpen
        onClose={vi.fn()}
        existingCount={2}
        onConfirm={onConfirm}
      />,
    ))

    await expect.element(page.getByText(/1 次角色同步待修复/)).toBeVisible()
    await expect.element(page.getByRole('button', { name: '开始生成' })).toBeEnabled()
    await act(async () => page.getByRole('button', { name: '重试角色同步' }).click())

    expect(invoke.mock.calls.some(([channel]) => (
      channel === 'db:blueprint-character-sync-complete'
    ))).toBe(true)
    expect(onConfirm).not.toHaveBeenCalled()
    await expect.element(page.getByRole('button', { name: '开始生成' })).toBeEnabled()
  })
})
