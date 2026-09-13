import { act } from 'react'
import { EditorView } from '@codemirror/view'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RecoveryCandidate } from '../../../shared/recovery-candidate'
import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import { saveDirtyEditorChangesForExit, useEditorStore } from '../../../stores/editor-store'
import { useLayoutStore } from '../../../stores/layout-store'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import AIOutputPanel from '../AIOutputPanel'
import EditorArea from '../EditorArea'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined
let invoke: ReturnType<typeof vi.fn>
let clipboardWrite: ReturnType<typeof vi.fn>
let storedCandidate: RecoveryCandidate

const projectPath = 'C:\\novels\\recovery-project'
const session = {
  projectId: 'recovery-project',
  leaseId: 'recovery-lease',
  projectPath,
}

function candidate(overrides: Partial<RecoveryCandidate> = {}): RecoveryCandidate {
  return {
    candidateId: 'candidate-1',
    runId: 'run-1',
    stepId: 'generate-draft',
    projectId: session.projectId,
    chapterNumber: 3,
    chapterTitle: '失控列车',
    sourceHash: 'a'.repeat(64),
    visibleText: '林岚推开驾驶室的门。',
    contentHash: 'b'.repeat(64),
    failureCode: 'PROVIDER_REQUEST_FAILED',
    failureReason: 'connection reset',
    status: 'pending',
    replacesCandidateId: null,
    sourceCurrent: true,
    createdAt: '2026-09-06T00:00:00.000Z',
    resolvedAt: null,
    ...overrides,
  }
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(container?.querySelectorAll('button') ?? [])
    .find(item => item.textContent?.includes(label))
}

beforeEach(() => {
  useWorkflowStore.setState({ activeRuns: [], history: [], currentRun: null })
  useProjectStore.setState({
    currentProject: {
      id: session.projectId,
      name: 'Recovery project',
      path: projectPath,
      sessionLease: session.leaseId,
      novelConfig: {},
    } as never,
  })
  setActiveProjectSessionContext(session)
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
  useLayoutStore.setState({ sidebarView: 'project' })
  storedCandidate = candidate()
  invoke = vi.fn(async (channel: string, candidateId?: string, visibleText?: string) => {
    if (channel === 'db:recovery-candidate-list') return [storedCandidate]
    if (channel === 'db:recovery-candidate-update') {
      storedCandidate = candidate({ candidateId, visibleText })
      return { success: true, candidate: storedCandidate }
    }
    if (channel === 'db:recovery-candidate-resolve') return { success: true }
    throw new Error(`unexpected IPC: ${channel}`)
  })
  clipboardWrite = vi.fn().mockResolvedValue(undefined)
  Object.assign(window, {
    aiNovelAPI: {
      invoke,
      on: vi.fn(),
      once: vi.fn(),
      send: vi.fn(),
      setZoomLevel: vi.fn(),
      setZoomFactor: vi.fn(),
      getZoomLevel: vi.fn(),
    },
  })
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: clipboardWrite },
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  setActiveProjectSessionContext(null)
  delete (window as typeof window & { aiNovelAPI?: unknown }).aiNovelAPI
})

describe('AI output recovery candidates', () => {
  it('discovers a pending candidate after project reopen and copies or continues it explicitly', async () => {
    await act(async () => {
      root?.render(<AIOutputPanel />)
      await Promise.resolve()
    })

    expect(container?.textContent).toContain('恢复候选')
    expect(container?.textContent).toContain('原始候选')
    expect(container?.textContent).toContain('第3章 失控列车')
    expect(container?.textContent).toContain('林岚推开驾驶室的门。')

    await act(async () => button('复制')?.click())
    expect(clipboardWrite).toHaveBeenCalledWith('林岚推开驾驶室的门。')

    await act(async () => {
      button('继续编辑')?.click()
      await Promise.resolve()
    })
    expect(invoke).toHaveBeenCalledWith(
      'db:recovery-candidate-update',
      'candidate-1',
      '林岚推开驾驶室的门。',
      projectPath,
      session,
    )
    expect(invoke).not.toHaveBeenCalledWith(
      'db:recovery-candidate-resolve',
      'candidate-1',
      'continued',
      projectPath,
      session,
    )
    expect(useEditorStore.getState().tabs).toEqual([
      expect.objectContaining({
        type: 'chapter',
        content: '林岚推开驾驶室的门。',
        savedContent: '林岚推开驾驶室的门。',
        dirty: false,
        projectKey: projectPath,
        projectSessionLease: session.leaseId,
      }),
    ])
    expect(container?.textContent).not.toContain('林岚推开驾驶室的门。')

    await act(async () => {
      root?.render(<EditorArea onNewProject={vi.fn()} />)
      await Promise.resolve()
    })
    const recoveryTab = useEditorStore.getState().tabs.find(tab => (
      tab.filePath === 'ai-novel://recovery/candidate-1'
    ))!
    await act(async () => useEditorStore.getState().setActiveTab(recoveryTab.id))

    expect(container?.textContent).toContain('项目恢复候选')
    expect(container?.textContent).toContain('林岚推开驾驶室的门。')
    await act(async () => {
      const editor = EditorView.findFromDOM(container!.querySelector<HTMLElement>('.cm-editor')!)!
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: '林岚停下列车，保存现场。' },
      })
    })
    expect(container?.querySelector('button[title^="保存"]')).not.toBeNull()
    await act(async () => saveDirtyEditorChangesForExit(projectPath))
    expect(useEditorStore.getState().tabs.find(tab => tab.id === recoveryTab.id)).toEqual(
      expect.objectContaining({
        content: '林岚停下列车，保存现场。',
        dirty: false,
        savedContent: '林岚停下列车，保存现场。',
      }),
    )
    expect(invoke).toHaveBeenCalledWith(
      'db:recovery-candidate-update',
      'candidate-1',
      '林岚停下列车，保存现场。',
      projectPath,
      session,
    )
    expect(invoke.mock.calls.some(([channel]) => (
      channel === 'fs:write-file'
      || channel === 'db:draft-create'
      || channel === 'db:draft-update-content'
      || channel === 'db:finalization-upsert'
      || channel.startsWith('kb:')
    ))).toBe(false)

    await act(async () => {
      root?.render(<AIOutputPanel />)
      await Promise.resolve()
    })
    expect(container?.textContent).toContain('林岚停下列车，保存现场。')
  })

  it('discards explicitly without creating an editor tab', async () => {
    await act(async () => {
      root?.render(<AIOutputPanel />)
      await Promise.resolve()
    })
    await act(async () => {
      button('放弃')?.click()
      await Promise.resolve()
    })

    expect(invoke).toHaveBeenCalledWith(
      'db:recovery-candidate-resolve',
      'candidate-1',
      'discarded',
      projectPath,
      session,
    )
    expect(useEditorStore.getState().tabs).toEqual([])
  })

  it('blocks continue after the source changed while keeping copy and discard available', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'db:recovery-candidate-list') return [candidate({ sourceCurrent: false })]
      if (channel === 'db:recovery-candidate-resolve') return { success: true }
      throw new Error(`unexpected IPC: ${channel}`)
    })
    await act(async () => {
      root?.render(<AIOutputPanel />)
      await Promise.resolve()
    })

    expect(container?.textContent).toContain('源章节已变化')
    expect(button('继续编辑')).toBeDisabled()
    expect(button('复制')).not.toBeDisabled()
    expect(button('放弃')).not.toBeDisabled()
  })
})
