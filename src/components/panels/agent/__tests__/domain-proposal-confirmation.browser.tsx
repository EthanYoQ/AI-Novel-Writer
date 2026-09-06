import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { useLocaleStore } from '../../../../stores/locale-store'
import { useProjectStore } from '../../../../stores/project-store'
import { useAgentStore } from '../../../../stores/agent-store'
import ConfirmCard from '../ConfirmCard'
import ArtifactCard from '../ArtifactCard'

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
const blueprint = {
  chapterNumber: 2, title: '旧标题', role: '发展', purpose: '推进调查', keyEvents: '找到线索',
  characters: ['林舟'], suspenseHook: '谁在说谎', userGuidance: '', notes: '', notesUpdatedAt: '',
}

let container: HTMLDivElement
let root: Root
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

async function flushImpactReads() {
  await act(async () => new Promise(resolve => setTimeout(resolve, 0)))
}

beforeEach(() => {
  resolveToolConfirmation.mockReset()
  cancelGeneration.mockReset()
  invoke.mockReset()
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'db:blueprint-get-all' || channel === 'db:draft-list-all' || channel === 'db:narrative-thread-list') return []
    return undefined
  })
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
  it('shows generic confirmation and artifact labels in English', async () => {
    useLocaleStore.setState({ locale: 'en-US', initialized: true })
    await act(async () => root.render(<>
      <ConfirmCard toolCall={{
        id: 'write-1', toolName: 'write_file', arguments: { file_path: 'chapter.md' },
        status: 'waiting_confirm', source: 'builtin', projectSession: session,
      }} />
      <ArtifactCard artifact={{
        type: 'file_created', name: 'chapter.md', path: 'C:/novels/A/chapter.md',
        projectPath: session.projectPath, projectSession: session,
      }} />
    </>))

    await expect.element(page.getByText('Will write file: chapter.md')).toBeVisible()
    await expect.element(page.getByText('New file')).toBeVisible()
    expect(container.textContent).not.toMatch(/将写入文件|新建文件/u)
  })

  it('shows an English field diff instead of raw tool JSON and approves the existing gate', async () => {
    useLocaleStore.setState({ locale: 'en-US', initialized: true })
    await act(async () => root.render(<ConfirmCard toolCall={{
      id: 'config-1', toolName: 'propose_novel_config', arguments: { changes: { genre: 'Science fiction' } },
      status: 'waiting_confirm', source: 'builtin', projectSession: session,
    }} />))
    await flushImpactReads()

    await expect.element(page.getByText('Genre', { exact: true })).toBeVisible()
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
    await flushImpactReads()

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
    await flushImpactReads()
    await expect.element(page.getByText(/proposal is stale/)).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Approve' })).toBeDisabled()
  })

  it('cancels the whole Agent task without executing a domain write', async () => {
    useLocaleStore.setState({ locale: 'en-US', initialized: true })
    await act(async () => root.render(<ConfirmCard toolCall={{
      id: 'cancel-1', toolName: 'propose_novel_config', arguments: { changes: { genre: 'Mystery' } },
      status: 'waiting_confirm', source: 'builtin', projectSession: session,
    }} />))
    await flushImpactReads()
    await page.getByRole('button', { name: 'Cancel this Agent task' }).click()
    expect(cancelGeneration).toHaveBeenCalledOnce()
    expect(resolveToolConfirmation).not.toHaveBeenCalled()
    expect(invoke.mock.calls.every(([channel]) => channel !== 'project:update-config' && channel !== 'db:blueprint-upsert')).toBe(true)
  })

  it('previews English config impacts and sends only the selected unwritten blueprint diff to the existing gate', async () => {
    useLocaleStore.setState({ locale: 'en-US', initialized: true })
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'db:blueprint-get-all') return [
        { ...blueprint, chapterNumber: 2, title: 'The sealed door' },
        { ...blueprint, chapterNumber: 3, title: 'The old verdict' },
        { ...blueprint, chapterNumber: 4, title: 'Draft in progress' },
      ]
      if (channel === 'db:draft-list-all') return [
        { id: 1, chapterNumber: 1, chapterTitle: 'Opening', version: 1, status: 'finalized' },
        { id: 3, chapterNumber: 3, chapterTitle: 'The old verdict', version: 1, status: 'finalized' },
        { id: 4, chapterNumber: 4, version: 1, status: 'draft' },
      ]
      if (channel === 'db:narrative-thread-list') return [
        {
          id: 7, title: 'The blue key', type: 'foreshadowing', status: 'progressing',
          targetStartChapter: 2, targetEndChapter: 6, authorIntent: 'Reveal the witness later',
          dormantChapters: 0, overdue: false, events: [], createdAt: '', updatedAt: '',
        },
        {
          id: 8, title: 'Closed thread', type: 'foreshadowing', status: 'resolved',
          targetStartChapter: 1, targetEndChapter: 3, authorIntent: 'Already resolved',
          dormantChapters: 0, overdue: false, events: [], createdAt: '', updatedAt: '',
        },
      ]
      throw new Error(`unexpected channel ${channel}`)
    })

    await act(async () => root.render(<ConfirmCard toolCall={{
      id: 'impact-1', toolName: 'propose_novel_config',
      arguments: {
        changes: { coreOutline: 'The witness hid the blue key.' },
        blueprint_changes: [
          { chapter_number: 2, changes: { purpose: 'Plant the blue-key clue' } },
          { chapter_number: 3, changes: { purpose: 'Must remain finalized' } },
          { chapter_number: 4, changes: { purpose: 'Must remain a work in progress' } },
        ],
      },
      status: 'waiting_confirm', source: 'builtin', projectSession: session,
    }} />))
    await flushImpactReads()

    await expect.element(page.getByText('Potential impact')).toBeVisible()
    await expect.element(page.getByText('Chapter 2 · The sealed door', { exact: true })).toBeVisible()
    await expect.element(page.getByText('The blue key', { exact: true })).toBeVisible()
    await expect.element(page.getByText('Opening')).toBeVisible()
    await expect.element(page.getByText('The old verdict')).toBeVisible()
    await expect.element(page.getByText('Plant the blue-key clue')).toBeVisible()
    await expect.element(page.getByText('Must remain finalized')).not.toBeInTheDocument()
    await expect.element(page.getByText('Must remain a work in progress')).not.toBeInTheDocument()

    await act(async () => page.getByRole('checkbox', { name: /Chapter 2.*Purpose/u }).click())
    await page.getByRole('button', { name: 'Approve' }).click()

    expect(resolveToolConfirmation).toHaveBeenCalledWith('impact-1', true, {
      blueprintProposals: [{
        name: 'propose_chapter_blueprint',
        arguments: { chapter_number: 2, changes: { purpose: 'Plant the blue-key clue' } },
      }],
    })
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(expect.arrayContaining([
      'db:blueprint-get-all', 'db:draft-list-all', 'db:narrative-thread-list',
    ]))
  })

  it('shows the Chinese impact preview but cancels it without any domain write', async () => {
    useLocaleStore.setState({ locale: 'zh-CN', initialized: true })
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'db:blueprint-get-all') return [{ ...blueprint, chapterNumber: 2, title: '封闭的门' }]
      if (channel === 'db:draft-list-all') return []
      if (channel === 'db:narrative-thread-list') return []
      throw new Error(`unexpected channel ${channel}`)
    })

    await act(async () => root.render(<ConfirmCard toolCall={{
      id: 'impact-cancel', toolName: 'propose_novel_config',
      arguments: {
        changes: { worldSetting: '城市禁止公开使用魔法' },
        blueprint_changes: [{ chapter_number: 2, changes: { keyEvents: '主角隐藏魔法痕迹' } }],
      },
      status: 'waiting_confirm', source: 'builtin', projectSession: session,
    }} />))
    await flushImpactReads()

    await expect.element(page.getByText('潜在影响')).toBeVisible()
    await page.getByRole('button', { name: '取消本次助手任务' }).click()
    expect(cancelGeneration).toHaveBeenCalledOnce()
    expect(resolveToolConfirmation).not.toHaveBeenCalled()
    expect(invoke.mock.calls.every(([channel]) => channel !== 'project:update-config' && channel !== 'db:blueprint-upsert')).toBe(true)
  })
})
