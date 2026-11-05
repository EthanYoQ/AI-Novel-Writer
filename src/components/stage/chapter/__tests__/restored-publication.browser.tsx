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
import { openDraftTab } from '../../../../stores/open-draft-tab'
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

async function openDraft(draftId: number) {
  await act(async () => { await useDraftStore.getState().loadAllDrafts(SESSION.projectPath, SESSION) })
  const draft = Object.values(useDraftStore.getState().draftsByChapter).flat().find(candidate => candidate.id === draftId)!
  await act(async () => { await openDraftTab(draft, `第 ${draft.chapterNumber} 章`, SESSION) })
}

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

    await openDraft(final.id)
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
    await openDraft(final.id)
    await expect.element(page.getByRole('button', { name: '重新打开修改' })).toBeVisible()
    expect(page.getByText('正文文件').query()).toBeNull()
  })
})
