/* eslint-disable react-refresh/only-export-components */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { StoreApi } from 'zustand'

import type { ProjectData, ProjectSessionContext } from '../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import { useDraftStore } from '../../../stores/draft-store'
import { useEditorStore } from '../../../stores/editor-store'
import { useStageStore } from '../../../stores/navigation/stage-store'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore, type WorkflowRun } from '../../../stores/workflow-store'
import { useStageView, type StageView } from '../use-stage-work'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PATH = 'C:\\novels\\view'
const SESSION: ProjectSessionContext = { projectId: 'view', leaseId: 'lease', projectPath: PATH }

function snapshot<T>(store: StoreApi<T>): () => void {
  const state = store.getState()
  return () => store.setState(state, true)
}
const restores = [snapshot(useDraftStore), snapshot(useEditorStore), snapshot(useStageStore), snapshot(useProjectStore), snapshot(useWorkflowStore)]

let root: Root | undefined
let host: HTMLDivElement | undefined
let renders = 0
let latest: StageView | undefined

function Probe() {
  const view = useStageView()
  useEffect(() => {
    renders++
    latest = view
  })
  return null
}

function writing(progress: number): WorkflowRun {
  return { id: 'run', projectPath: PATH, status: 'running', title: '写第 2 章', currentStepIndex: 0, resourceKeys: ['chapter:2'],
    steps: [{ id: 'write', name: '写草稿', status: 'running', progress, logs: [] }] } as unknown as WorkflowRun
}

beforeEach(async () => {
  setActiveProjectSessionContext(SESSION)
  useProjectStore.setState({ currentProject: { id: SESSION.projectId, sessionLease: SESSION.leaseId, name: '灯塔', path: PATH, novelConfig: {} } as unknown as ProjectData })
  useStageStore.setState({ work: { session: SESSION, architecture: {}, blueprints: [1, 2].map(chapterNumber => ({ chapterNumber, title: `第${chapterNumber}章` })) }, spineFacts: SESSION })
  useDraftStore.setState({ dataProjectSession: SESSION, loading: false, draftsByChapter: {} })
  useWorkflowStore.setState({ activeRuns: [writing(10)] })
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
  useEditorStore.getState().openFile({ id: 'ai-novel://draft/11', name: '第 1 章', type: 'chapter', filePath: 'ai-novel://draft/11',
    content: '雾', savedContent: '雾', chapterNumber: 1, projectKey: PATH })
  renders = 0
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<Probe />))
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  setActiveProjectSessionContext(null)
  for (const restore of restores) restore()
})

describe('流程脊视图的订阅', () => {
  it('在正文里打字、运行进度推进时不重算外壳；换到别的章才更新位置', async () => {
    const before = renders
    const location = latest!.location
    expect(location).toEqual({ kind: 'stage', stage: 'manuscript', chapter: 1 })
    expect(latest!.chapters.map(row => row.running)).toEqual([false, true])

    await act(async () => useEditorStore.getState().updateTabContent(useEditorStore.getState().activeTabId!, '雾是从海面上爬上来的'))
    await act(async () => useWorkflowStore.setState({ activeRuns: [writing(60)] }))
    expect(renders).toBe(before)
    expect(latest!.location).toBe(location)

    await act(async () => useEditorStore.getState().openFile({ id: 'ai-novel://draft/21', name: '第 2 章', type: 'chapter',
      filePath: 'ai-novel://draft/21', content: '潮', savedContent: '潮', chapterNumber: 2, projectKey: PATH }))
    expect(latest!.location).toEqual({ kind: 'stage', stage: 'manuscript', chapter: 2 })
  })
})
