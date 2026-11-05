import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { TrashedChapter } from '../../../../shared/chapter-deletion'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { useDraftStore } from '../../../../stores/draft-store'
import { useEditorStore } from '../../../../stores/editor-store'
import { useLLMStore } from '../../../../stores/llm-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useStageStore } from '../../../../stores/navigation/stage-store'
import { useProjectStore } from '../../../../stores/project-store'
import { useWorkflowStore } from '../../../../stores/workflow-store'
import { openChapter } from '../../../../stores/navigation/stage-navigation'
import { openPageTab } from '../../../../stores/navigation/page-tabs'
import { toast } from '../../../ui/Toast'
import { restoreTrashedChapter } from '../../trash/trash-actions'
import StageWorkspace from '../../StageWorkspace'
import { BLUEPRINT, SESSION, chapterProject, createChapterBackend, generationModel } from './chapter-fixture'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const original = {
  editor: useEditorStore.getState(), project: useProjectStore.getState(), drafts: useDraftStore.getState(),
  stage: useStageStore.getState(), llm: useLLMStore.getState(), workflow: useWorkflowStore.getState(),
}

let root: Root | undefined
let host: HTMLDivElement | undefined
let backend: ReturnType<typeof createChapterBackend>

async function mount() {
  host = document.createElement('div')
  host.className = 'paper-ink stage-shell'
  host.style.cssText = 'display:flex;flex-direction:column;height:900px;width:1028px'
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<StageWorkspace library={false} focus={false} />))
}

/** 侧栏点第 3 章走的就是 openChapter：没开过就读正文开新标签，开着就切过去。 */
async function openChapterThree() {
  await act(async () => { await openChapter(3) })
}

const restoredPending = (draftId: number) => ({ success: true, outcome: 'restored', chapterNumber: 3, draftId, finalizationId: 'fin-restored-3',
  publicationStatus: 'pending', publicationError: 'MANUSCRIPT_WRITE_FAILED' })

function trashed(draftId: number): TrashedChapter {
  return {
    deletionId: 'del-3', draftId, chapterNumber: 3, chapterTitle: BLUEPRINT.title, deletedAt: '2026-11-05T06:00:00.000Z',
    wordCount: 3120, versionCount: 1, cleanup: 'completed', restoreMode: 'into-gap',
  }
}

beforeEach(async () => {
  await page.viewport(1280, 900)
  backend = createChapterBackend()
  backend.install()
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({ currentProject: chapterProject() })
  setActiveProjectSessionContext(SESSION)
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
  useStageStore.setState({ work: { session: SESSION, architecture: {}, blueprints: [{ chapterNumber: 3, title: BLUEPRINT.title }] }, spineFacts: SESSION, chapterRequest: null, writeRequest: null, sheet: null })
  useLLMStore.setState({ models: [generationModel('glm')], defaultModelId: 'glm', loaded: true })
  useWorkflowStore.setState({ activeRuns: [], history: [], startWorkflow: vi.fn(async () => 'chapter-run') as never, addLog: vi.fn() as never, getResourceConflict: (() => null) as never })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  Reflect.deleteProperty(window, 'aiNovelAPI')
  setActiveProjectSessionContext(null)
  useEditorStore.setState(original.editor, true)
  useProjectStore.setState(original.project, true)
  useDraftStore.setState(original.drafts, true)
  useStageStore.setState(original.stage, true)
  useLLMStore.setState(original.llm, true)
  useWorkflowStore.setState(original.workflow, true)
})

describe('从回收站恢复的章节', () => {
  it('恢复成功但实体稿没写出：打开这一章，「定稿后处理」里有「重新写入正文」，点它按恢复给的定稿重写（#592）', async () => {
    const final = backend.addDraft({ status: 'finalized' })
    const plain = backend.invoke.getMockImplementation()!
    backend.invoke.mockImplementation(async (channel, ...args) => {
      if (channel === 'chapter:trash-restore') {
        backend.state.calls.push({ channel, args })
        return { success: true, outcome: 'restored', chapterNumber: 3, draftId: final.id, finalizationId: 'fin-restored-3',
          publicationStatus: 'pending', publicationError: 'MANUSCRIPT_WRITE_FAILED' }
      }
      if (channel === 'finalization:retry') {
        backend.state.calls.push({ channel, args })
        return { success: true, committed: true, finalizationId: args[0], publicationStatus: 'published' }
      }
      return plain(channel, ...args)
    })
    const warning = vi.spyOn(toast, 'warning')
    await mount()

    await act(async () => { await restoreTrashedChapter(trashed(final.id)) })
    expect(warning.mock.calls[0]?.[0]).toContain('「重新写入正文」')

    await openChapterThree()
    const retry = page.getByRole('button', { name: '重新写入正文', exact: true })
    await expect.element(retry).toBeVisible()
    await act(async () => retry.click())
    await vi.waitFor(() => expect(backend.writes('finalization:retry')).toEqual([['fin-restored-3', SESSION]]))
    await expect.element(page.getByText('已写入项目目录')).toBeVisible()
  })

  it('恢复后实体稿照常写出：打开这一章不列「正文文件」这一步', async () => {
    const final = backend.addDraft({ status: 'finalized' })
    const plain = backend.invoke.getMockImplementation()!
    backend.invoke.mockImplementation(async (channel, ...args) => channel === 'chapter:trash-restore'
      ? { success: true, outcome: 'restored', chapterNumber: 3, draftId: final.id, finalizationId: 'fin-restored-3', publicationStatus: 'published' }
      : plain(channel, ...args))
    await mount()

    await act(async () => { await restoreTrashedChapter(trashed(final.id)) })
    await openChapterThree()
    await expect.element(page.getByRole('button', { name: '重新打开修改' })).toBeVisible()
    expect(page.getByText('正文文件').query()).toBeNull()
  })

  it('恢复时这一章的标签早已开着、作者在别处：从侧栏切回这一章，有「重新写入正文」（#592）', async () => {
    const final = backend.addDraft({ status: 'finalized' })
    const plain = backend.invoke.getMockImplementation()!
    backend.invoke.mockImplementation(async (channel, ...args) => channel === 'chapter:trash-restore' ? restoredPending(final.id) : plain(channel, ...args))
    await mount()
    await openChapterThree()
    await act(async () => openPageTab('blueprint'))
    const tabs = useEditorStore.getState().tabs.length

    await act(async () => { await restoreTrashedChapter(trashed(final.id)) })
    await openChapterThree()
    expect(useEditorStore.getState().tabs, '切回已开的标签，没有另开').toHaveLength(tabs)
    await expect.element(page.getByRole('button', { name: '重新写入正文', exact: true })).toBeVisible()
  })

  it('恢复时这一章正开在眼前：不用切走再切回，「重新写入正文」就出现（#592）', async () => {
    const final = backend.addDraft({ status: 'finalized' })
    const plain = backend.invoke.getMockImplementation()!
    backend.invoke.mockImplementation(async (channel, ...args) => channel === 'chapter:trash-restore' ? restoredPending(final.id) : plain(channel, ...args))
    await mount()
    await openChapterThree()
    await expect.element(page.getByRole('button', { name: '重新打开修改' })).toBeVisible()

    await act(async () => { await restoreTrashedChapter(trashed(final.id)) })
    await expect.element(page.getByRole('button', { name: '重新写入正文', exact: true })).toBeVisible()
  })

  it('打开过一次、没重写就关掉标签：再从侧栏打开，「重新写入正文」还在（#592）', async () => {
    const final = backend.addDraft({ status: 'finalized' })
    const plain = backend.invoke.getMockImplementation()!
    backend.invoke.mockImplementation(async (channel, ...args) => channel === 'chapter:trash-restore' ? restoredPending(final.id) : plain(channel, ...args))
    await mount()

    await act(async () => { await restoreTrashedChapter(trashed(final.id)) })
    await openChapterThree()
    await expect.element(page.getByRole('button', { name: '重新写入正文', exact: true })).toBeVisible()
    await act(async () => useEditorStore.getState().closeTab(useEditorStore.getState().activeTabId!))
    expect(useEditorStore.getState().tabs).toHaveLength(0)

    await openChapterThree()
    await expect.element(page.getByRole('button', { name: '重新写入正文', exact: true })).toBeVisible()
  })

})
