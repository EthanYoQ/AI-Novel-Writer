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
let invoke: ReturnType<typeof vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>>
let authoritativeNextChapter: number
let authorityGap: number | null
let blueprintChapterNumbers: number[]
let planningPreferences: { outlineTargetUnits?: number; blueprintTargetUnits?: number }

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
  planningPreferences = {}
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({ currentProject: project as never })
  useWorkflowStore.setState({
    activeRuns: [], history: [], globalLogs: [], waitingRuns: {}, currentRun: null,
    waitingForConfirm: false, waitingAfterStepIndex: -1,
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'config:get') return planningPreferences
    if (channel === 'config:set') {
      const patch = args[0]
      if (typeof patch !== 'object' || patch === null) throw new Error('Invalid preference patch')
      planningPreferences = { ...planningPreferences, ...patch }
      return { success: true }
    }
    if (channel === 'generation:list-directory-progress') return { progress: [], diagnostics: [] }
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
  Object.defineProperty(window, 'aiNovelAPI', {
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
  Reflect.deleteProperty(window, 'aiNovelAPI')
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

  it('defaults a large-book synopsis batch to chapters 1-5 and a 600-character target', async () => {
    useProjectStore.setState({
      currentProject: {
        ...project,
        novelConfig: { ...project.novelConfig, totalChapters: 100 },
      } as never,
    })
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    await act(async () => root.render(
      <ArchitectureConfirmDialog
        isOpen
        onClose={vi.fn()}
        archStatus={{ premise: true, characters: true, worldbuilding: true, synopsis: false }}
        initialSelectedSteps={['synopsis']}
        onConfirm={onConfirm}
      />,
    ))

    await expect.element(page.getByRole('spinbutton', { name: '本次生成范围的起始章' })).toHaveValue(1)
    await expect.element(page.getByRole('spinbutton', { name: '本次生成范围的结束章' })).toHaveValue(5)
    await expect.element(page.getByRole('spinbutton', { name: '每章大纲目标字数' })).toHaveValue(600)
    await act(async () => page.getByRole('button', { name: /确认生成/ }).click())

    await vi.waitFor(() => expect(onConfirm).toHaveBeenCalledWith(
      ['synopsis'],
      {},
      { from: 1, to: 5 },
      600,
    ))
  })

  it('keeps the continuation start and caps the prefilled new action at ten chapters', async () => {
    useProjectStore.setState({
      currentProject: {
        ...project,
        novelConfig: { ...project.novelConfig, totalChapters: 100 },
      } as never,
    })
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    await act(async () => root.render(
      <ArchitectureConfirmDialog
        isOpen
        onClose={vi.fn()}
        archStatus={{ premise: true, characters: true, worldbuilding: true, synopsis: true }}
        initialSelectedSteps={['synopsis']}
        initialSynopsisRange={{ from: 21, to: 40 }}
        onConfirm={onConfirm}
      />,
    ))

    await expect.element(page.getByRole('spinbutton', { name: '本次生成范围的起始章' })).toHaveValue(21)
    await expect.element(page.getByRole('spinbutton', { name: '本次生成范围的结束章' })).toHaveValue(30)
    await act(async () => page.getByRole('button', { name: /确认生成/ }).click())

    await vi.waitFor(() => expect(onConfirm).toHaveBeenCalledWith(
      ['synopsis'],
      {},
      { from: 21, to: 30 },
      600,
    ))
  })

  it.each(['', '0', '-1', '1.5'])('rejects invalid synopsis range value %s without falling back to the whole book', async invalidFrom => {
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    await act(async () => root.render(
      <ArchitectureConfirmDialog
        isOpen
        onClose={vi.fn()}
        archStatus={{ premise: true, characters: true, worldbuilding: true, synopsis: false }}
        initialSelectedSteps={['synopsis']}
        onConfirm={onConfirm}
      />,
    ))

    await act(async () => page.getByRole('spinbutton', { name: '本次生成范围的起始章' }).fill(invalidFrom))
    await act(async () => page.getByRole('button', { name: /确认生成/ }).click())

    await expect.element(page.getByText(/情节大纲范围无效/)).toBeVisible()
    expect(onConfirm).not.toHaveBeenCalled()
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
      if (channel === 'generation:list-directory-progress') return { progress: [], diagnostics: [] }
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


it('shows the committed directory chain endpoint and resumes only its explicit remaining receipt', async () => {
  const handle = { projectId: project.id, epoch: '上次会话', rootActionId: '原作者动作', runId: '最初运行' }
  const nextHandle = { ...handle, runId: '后续运行' }
  const original = invoke.getMockImplementation() as (channel: string, ...args: unknown[]) => Promise<unknown>
  invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    if (channel === 'generation:list-directory-progress') return { progress: [
      { operationId: '父提交', payloadHash: 'a'.repeat(64), sourceHandle: handle,
        requestedRange: { startChapter: 1, endChapter: 200 }, committedRange: { startChapter: 1, endChapter: 160 },
        remainingRange: { startChapter: 161, endChapter: 200 }, continuationHandle: nextHandle },
      { operationId: '末端提交', payloadHash: 'b'.repeat(64), sourceHandle: nextHandle,
        requestedRange: { startChapter: 161, endChapter: 200 }, committedRange: { startChapter: 161, endChapter: 180 },
        remainingRange: { startChapter: 181, endChapter: 200 } },
    ], diagnostics: [] }
    return original(channel, ...args)
  })
  const onConfirm = vi.fn(async () => {})
  await act(async () => root.render(<DirectoryConfigDialog isOpen onClose={() => {}} existingCount={180} onConfirm={onConfirm} />))
  await expect.element(page.getByText('已保存第 161–180 章蓝图。')).toBeVisible()
  await expect.element(page.getByRole('button', { name: '继续第 161–200 章（沿用原预算）' })).not.toBeInTheDocument()
  await act(async () => page.getByRole('button', { name: '继续第 181–200 章（沿用原预算）' }).click())
  expect(onConfirm).toHaveBeenCalledWith({ mode: 'append', continueDirectoryOperationId: '末端提交' })
})


it('shows blueprint recovery diagnostics without blocking independent generation', async () => {
  const original = invoke.getMockImplementation()!
  invoke.mockImplementation(async (channel, ...args) => {
    if (channel === 'generation:list-directory-progress') return { progress: [], diagnostics: [
      { runId: 'retired', kind: 'retired', code: 'GENERATION_BLUEPRINTS_CLEARED' },
      { runId: 'invalid-progress', kind: 'invalid', code: 'GENERATION_DIRECTORY_PROGRESS_INVALID' },
      { runId: 'invalid-author-save', kind: 'invalid', code: 'GENERATION_BLUEPRINT_AUTHOR_RECEIPT_INVALID' },
    ] }
    return original(channel, ...args)
  })
  const onConfirm = vi.fn(async () => {})
  await act(async () => root.render(<DirectoryConfigDialog isOpen onClose={() => {}} existingCount={0} onConfirm={onConfirm} />))
  await expect.element(page.getByText('蓝图已清空，旧生成记录不能续接')).toBeVisible()
  await expect.element(page.getByText('旧蓝图生成进度校验失败，不能续接')).toBeVisible()
  await expect.element(page.getByText('旧蓝图作者保存记录校验失败，不能续接')).toBeVisible()
  await expect.element(page.getByRole('button', { name: '开始生成' })).toBeEnabled()
  await act(async () => page.getByRole('button', { name: '开始生成' }).click())
  expect(onConfirm).toHaveBeenCalledOnce()
  expect(onConfirm).toHaveBeenCalledWith({ mode: 'full', startChapter: 1, count: 5, targetUnits: 600, pacingGuidance: undefined })
})


it('rejects a new 200-chapter action while retaining the entered value', async () => {
  useProjectStore.setState({ currentProject: { ...project, novelConfig: { ...project.novelConfig, totalChapters: 200 } } as never })
  const onConfirm = vi.fn(async () => {})
  await act(async () => root.render(<DirectoryConfigDialog isOpen onClose={() => {}} existingCount={0} onConfirm={onConfirm} />))
  await act(async () => page.getByRole('spinbutton').nth(0).fill('200'))
  await expect.element(page.getByRole('button', { name: '开始生成' })).toBeEnabled()
  await act(async () => page.getByRole('button', { name: '开始生成' }).click())
  expect(onConfirm).not.toHaveBeenCalled()
  await expect.element(page.getByText(/请选择有效的连续 1–10 章/)).toBeVisible()
  await expect.element(page.getByRole('spinbutton', { name: '本次蓝图章数' })).toHaveValue(200)
})

it.each(['outline', 'blueprint'] as const)('persists the %s target independently and accepts ten chapters with target 1000', async kind => {
  planningPreferences = { outlineTargetUnits: 700, blueprintTargetUnits: 800 }
  useProjectStore.setState({ currentProject: { ...project, novelConfig: { ...project.novelConfig, totalChapters: 20 } } as never })
  const onConfirm = vi.fn(async () => {})
  const renderDialog = async (isOpen: boolean) => act(async () => root.render(kind === 'outline'
    ? <ArchitectureConfirmDialog isOpen={isOpen} onClose={() => {}} archStatus={{ premise: true, characters: true, worldbuilding: true }} initialSelectedSteps={['synopsis']} onConfirm={onConfirm} />
    : <DirectoryConfigDialog isOpen={isOpen} onClose={() => {}} existingCount={0} onConfirm={onConfirm} />))
  await renderDialog(true)
  const target = page.getByRole('spinbutton', { name: kind === 'outline' ? '每章大纲目标字数' : '每章蓝图目标字数' })
  await expect.element(target).toHaveValue(kind === 'outline' ? 700 : 800)
  await act(async () => {
    await target.fill('1000')
    await page.getByRole('spinbutton', { name: kind === 'outline' ? '本次生成范围的结束章' : '本次蓝图章数' }).fill('10')
    await page.getByRole('button', { name: kind === 'outline' ? /确认生成/ : '开始生成' }).click()
  })
  await vi.waitFor(() => expect(onConfirm).toHaveBeenCalledOnce())
  if (kind === 'outline') expect(onConfirm).toHaveBeenCalledWith(['synopsis'], {}, { from: 1, to: 10 }, 1000)
  else expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ count: 10, targetUnits: 1000 }))
  expect(planningPreferences).toEqual(kind === 'outline'
    ? { outlineTargetUnits: 1000, blueprintTargetUnits: 800 }
    : { outlineTargetUnits: 700, blueprintTargetUnits: 1000 })
  await renderDialog(false)
  await renderDialog(true)
  await expect.element(target).toHaveValue(1000)
})

it.each(['outline', 'blueprint'] as const)('rejects eleven chapters and target 1001 in the %s dialog', async kind => {
  useProjectStore.setState({ currentProject: { ...project, novelConfig: { ...project.novelConfig, totalChapters: 20 } } as never })
  const onConfirm = vi.fn(async () => {})
  await act(async () => root.render(kind === 'outline'
    ? <ArchitectureConfirmDialog isOpen onClose={() => {}} archStatus={{}} initialSelectedSteps={['synopsis']} onConfirm={onConfirm} />
    : <DirectoryConfigDialog isOpen onClose={() => {}} existingCount={0} onConfirm={onConfirm} />))
  const count = page.getByRole('spinbutton', { name: kind === 'outline' ? '本次生成范围的结束章' : '本次蓝图章数' })
  const submit = page.getByRole('button', { name: kind === 'outline' ? /确认生成/ : '开始生成' })
  await act(async () => { await count.fill('11'); await submit.click() })
  expect(onConfirm).not.toHaveBeenCalled()
  await act(async () => {
    await count.fill('10')
    await page.getByRole('spinbutton', { name: kind === 'outline' ? '每章大纲目标字数' : '每章蓝图目标字数' }).fill('1001')
    await submit.click()
  })
  await expect.element(page.getByText(/目标须为 1–1000 的整数/)).toBeVisible()
  expect(onConfirm).not.toHaveBeenCalled()
  expect(invoke.mock.calls.some(([channel]) => channel === 'config:set')).toBe(false)
})

it.each(['outline', 'blueprint'] as const)('retains %s input and does not start generation when saving preferences fails', async kind => {
  const original = invoke.getMockImplementation()!
  invoke.mockImplementation(async (channel, ...args) => {
    if (channel === 'config:set') return { success: false, error: 'disk unavailable' }
    return original(channel, ...args)
  })
  const onConfirm = vi.fn(async () => {})
  const onClose = vi.fn()
  await act(async () => root.render(kind === 'outline'
    ? <ArchitectureConfirmDialog isOpen onClose={onClose} archStatus={{}} initialSelectedSteps={['synopsis']} onConfirm={onConfirm} />
    : <DirectoryConfigDialog isOpen onClose={onClose} existingCount={0} onConfirm={onConfirm} />))
  const target = page.getByRole('spinbutton', { name: kind === 'outline' ? '每章大纲目标字数' : '每章蓝图目标字数' })
  await act(async () => { await target.fill('900'); await page.getByRole('button', { name: kind === 'outline' ? /确认生成/ : '开始生成' }).click() })
  await expect.element(page.getByText('目标字数偏好保存失败。请重试，输入已保留。')).toBeVisible()
  await expect.element(target).toHaveValue(900)
  expect(onConfirm).not.toHaveBeenCalled()
  expect(onClose).not.toHaveBeenCalled()
})

it('rejects full-book generation above ten chapters and does not normalize an empty quantity', async () => {
  useProjectStore.setState({ currentProject: { ...project, novelConfig: { ...project.novelConfig, totalChapters: 20 } } as never })
  const onConfirm = vi.fn(async () => {})
  await act(async () => root.render(<DirectoryConfigDialog isOpen onClose={() => {}} existingCount={0} onConfirm={onConfirm} />))
  await act(async () => { await page.getByText('全量生成（共 20 章）').click(); await page.getByRole('button', { name: '开始生成' }).click() })
  expect(onConfirm).not.toHaveBeenCalled()
  await act(async () => {
    await page.getByText('批量连续生成').click()
    await page.getByRole('spinbutton', { name: '本次蓝图章数' }).fill('')
    await page.getByRole('button', { name: '开始生成' }).click()
  })
  expect(onConfirm).not.toHaveBeenCalled()
  await expect.element(page.getByRole('spinbutton', { name: '本次蓝图章数' })).toHaveValue(null)
})
