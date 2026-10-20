import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EditorView } from '@codemirror/view'
import type { StoreApi } from 'zustand'

import type { ProjectData } from '../../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import type { RecoveryCandidate } from '../../../../shared/recovery-candidate'
import { saveDirtyEditorChangesForExit, useEditorStore } from '../../../../stores/editor-store'
import { useLayoutStore } from '../../../../stores/layout-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useStageStore } from '../../../../stores/navigation/stage-store'
import { useProjectStore } from '../../../../stores/project-store'
import { useWorkflowStore } from '../../../../stores/workflow-store'
import { toast } from '../../../ui/Toast'
import StageWorkspace from '../../StageWorkspace'
import { openEditorTool } from '../../../../services/agent/tools/open-editor.tool'
import { createAgentExecutionContext } from '../../../../services/agent/tools/project-context'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = { projectId: '灯塔', projectPath: 'C:/novels/lighthouse', leaseId: '本次打开' }
const restores = [useProjectStore, useWorkflowStore, useStageStore, useLocaleStore, useLayoutStore, useEditorStore]
  .map(store => { const state = (store as StoreApi<unknown>).getState(); return () => (store as StoreApi<unknown>).setState(state, true) })

const candidate = {
  candidateId: 'candidate-1', runId: '旧运行', stepId: '写稿', projectId: session.projectId, chapterNumber: 3, chapterTitle: '雾钟',
  sourceHash: 'h', visibleText: '潮水退去，钟声早了一刻。', contentHash: 'c', failureCode: 'timeout', failureReason: '超时',
  status: 'pending', replacesCandidateId: null, sourceCurrent: true, createdAt: '2026-10-12T07:00:00.000Z', resolvedAt: null,
} as RecoveryCandidate

let root: Root | undefined
let host: HTMLDivElement | undefined
let invoke: ReturnType<typeof vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>>

beforeEach(() => {
  invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'db:recovery-candidate-list') return [candidate]
    if (channel === 'generation:list-batches' || channel === 'generation:list' || channel === 'skills:list-user') return []
    if (channel === 'fs:check-exists') return false
    if (channel === 'db:recovery-candidate-update') return { success: true, candidate: { ...candidate, visibleText: args[1] as string } }
    throw new Error(`未配置调用：${channel}`)
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => {} } })
  useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath, sessionLease: session.leaseId, name: '灯塔', novelConfig: {} } as unknown as ProjectData })
  setActiveProjectSessionContext(session)
  useWorkflowStore.setState({ activeRuns: [], history: [], waitingRuns: {}, globalLogs: [] })
  useEditorStore.setState({ tabs: [], activeTabId: null })
  useLocaleStore.setState({ locale: 'zh-CN' })
  host = document.createElement('div')
  host.className = 'paper-ink stage-shell'
  host.style.cssText = 'width: 1280px; height: 800px; display: flex'
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  setActiveProjectSessionContext(null)
  for (const restore of restores) restore()
  vi.restoreAllMocks()
})

const button = (name: string) => [...host!.querySelectorAll('button')].find(candidate => candidate.textContent === name)
const saveKey = (target: HTMLElement) => target.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true }))
const writes = () => invoke.mock.calls.filter(([channel]) => channel === 'db:recovery-candidate-update'
  || channel === 'fs:write-file' || channel.startsWith('db:draft-') || channel.startsWith('kb:'))

describe('恢复候选与只读修稿', () => {
  it('运行侧页「继续编辑」打开的恢复候选在新外壳里可编辑，保存只写回这份候选，不碰正式草稿', async () => {
    await act(async () => useStageStore.setState({ sheet: { kind: 'run', tab: 'active' } }))
    await act(async () => root!.render(<StageWorkspace library={false} focus={false} />))
    await vi.waitFor(() => expect(button('继续编辑')).toBeTruthy())
    await act(async () => button('继续编辑')!.click())
    await vi.waitFor(() => expect(host!.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('true'))
    expect(host!.textContent).toContain('项目恢复候选；不会自动写入正式草稿')
    expect(host!.querySelector('h1')?.textContent).toBe('恢复候选 · 第3章 雾钟')
    expect(button('保存候选')?.disabled).toBe(true)

    await act(async () => {
      const view = EditorView.findFromDOM(host!.querySelector<HTMLElement>('.cm-editor')!)!
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '潮水退去，林岚听见钟声。' } })
    })
    expect(button('保存候选')?.disabled).toBe(false)
    await act(async () => { saveKey(host!.querySelector<HTMLElement>('.cm-content')!) })
    await vi.waitFor(() => expect(useEditorStore.getState().tabs[0]).toMatchObject({ dirty: false, savedContent: '潮水退去，林岚听见钟声。' }))
    expect(writes().map(([channel, ...args]) => [channel, args[0], args[1]])).toEqual([
      ['db:recovery-candidate-update', 'candidate-1', '潮水退去，钟声早了一刻。'],
      ['db:recovery-candidate-update', 'candidate-1', '潮水退去，林岚听见钟声。'],
    ])
  })

  it('恢复候选改了没保存就退出：退出前保存写回候选', async () => {
    useEditorStore.setState({ tabs: [{ id: 'recovery:candidate-1', name: '恢复候选 · 第3章 雾钟', type: 'chapter', filePath: 'ai-novel://recovery/candidate-1',
      content: candidate.visibleText, savedContent: candidate.visibleText, dirty: false, projectKey: session.projectPath }], activeTabId: 'recovery:candidate-1' })
    await act(async () => root!.render(<StageWorkspace library={false} focus={false} />))
    await vi.waitFor(() => expect(host!.querySelector('.cm-editor')).not.toBeNull())
    await act(async () => {
      const view = EditorView.findFromDOM(host!.querySelector<HTMLElement>('.cm-editor')!)!
      view.dispatch({ changes: { from: view.state.doc.length, insert: '风停了。' } })
    })
    await act(async () => saveDirtyEditorChangesForExit(session.projectPath))
    expect(useEditorStore.getState().tabs[0]).toMatchObject({ dirty: false, content: `${candidate.visibleText}风停了。` })
    expect(writes().map(([channel, , text]) => [channel, text])).toEqual([['db:recovery-candidate-update', `${candidate.visibleText}风停了。`]])
  })

  it('英文界面下保存恢复候选被拒、又没带原因时，提示也是英文，候选保持未保存', async () => {
    useLocaleStore.setState({ locale: 'en-US' })
    const errors = vi.spyOn(toast, 'error').mockImplementation(() => undefined)
    const plain = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel, ...args) => channel === 'db:recovery-candidate-update' ? { success: false } : plain(channel, ...args))
    useEditorStore.setState({ tabs: [{ id: 'recovery:candidate-1', name: 'Recovery candidate', type: 'chapter', filePath: 'ai-novel://recovery/candidate-1',
      content: candidate.visibleText, savedContent: candidate.visibleText, dirty: false, projectKey: session.projectPath }], activeTabId: 'recovery:candidate-1' })
    await act(async () => root!.render(<StageWorkspace library={false} focus={false} />))
    await vi.waitFor(() => expect(host!.querySelector('.cm-editor')).not.toBeNull())
    await act(async () => {
      const view = EditorView.findFromDOM(host!.querySelector<HTMLElement>('.cm-editor')!)!
      view.dispatch({ changes: { from: view.state.doc.length, insert: ' The wind dropped.' } })
    })
    await act(async () => { saveKey(host!.querySelector<HTMLElement>('.cm-content')!) })
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith('Could not save the recovery candidate.'))
    expect(useEditorStore.getState().tabs[0].dirty).toBe(true)
  })

  it.each(['merged', 'discarded'])('已%s的修稿只读显示，按 Ctrl S 不写任何东西', async status => {
    useEditorStore.setState({ tabs: [{ id: '修稿', name: `修稿合并：第3章（${status}）`, type: 'chapter', filePath: 'ai-novel://revision/9',
      content: '林岚从海港带回了信。', savedContent: '林岚从海港带回了信。', dirty: false, projectKey: session.projectPath, draftStatus: 'archived' }], activeTabId: '修稿' })
    await act(async () => root!.render(<StageWorkspace library={false} focus={false} />))
    await vi.waitFor(() => expect(host!.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('false'))
    expect(host!.textContent).toContain('林岚从海港带回了信。')
    expect(host!.textContent).toContain('这份修稿已经合并或放弃，只能查看')
    expect(button('保存候选')).toBeUndefined()
    await act(async () => { saveKey(host!.querySelector<HTMLElement>('.cm-content')!) })
    expect(writes()).toEqual([])
    expect(useEditorStore.getState().tabs[0]).toMatchObject({ dirty: false, content: '林岚从海港带回了信。' })
  })

  it('标签记的作品路径与当前作品只差大小写和分隔符时，仍显示这份正文', async () => {
    useEditorStore.setState({ tabs: [{ id: '修稿', name: '修稿合并：第3章（merged）', type: 'chapter', filePath: 'ai-novel://revision/9',
      content: '林岚从海港带回了信。', savedContent: '林岚从海港带回了信。', dirty: false, projectKey: 'c:\\Novels\\Lighthouse', draftStatus: 'archived' }], activeTabId: '修稿' })
    await act(async () => root!.render(<StageWorkspace library={false} focus={false} />))
    await vi.waitFor(() => expect(host!.textContent).toContain('林岚从海港带回了信。'))
    expect(host!.textContent).not.toContain('这个标签没有可显示的页面')
  })
})

describe('助手 open_editor 打开的作品目录文件', () => {
  it.each([['chapter', '第1章 雾钟.txt'], ['outline', '情节大纲.md']] as const)('%s 标签在纸墨外壳里显示文件内容，只读，按 Ctrl S 不写任何东西', async (tabType, filePath) => {
    const plain = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel, ...args) => channel === 'fs:read-file'
      ? { success: true, content: '潮水退去，钟声早了一刻。' } : plain(channel, ...args))
    const result = await openEditorTool.execute({ file_path: filePath, tab_type: tabType }, createAgentExecutionContext())
    expect(result.success).toBe(true)
    await act(async () => root!.render(<StageWorkspace library={false} focus={false} />))
    await vi.waitFor(() => expect(host!.textContent).toContain('潮水退去，钟声早了一刻。'))
    expect(host!.textContent).not.toContain('这个标签没有可显示的页面')
    expect(host!.querySelector('h1')?.textContent).toBe(filePath)
    expect(host!.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('false')
    await act(async () => { saveKey(host!.querySelector<HTMLElement>('.cm-content')!) })
    expect(writes()).toEqual([])
  })
})
