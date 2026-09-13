import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EditorView } from '@codemirror/view'

import { useProjectStore } from '../../../stores/project-store'
import { useLLMStore } from '../../../stores/llm-store'
import { useLocaleStore } from '../../../stores/locale-store'
import CodeMirrorEditor from '../CodeMirrorEditor'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type EventListener = (data: never) => void

let root: Root
let container: HTMLDivElement
let invoke: ReturnType<typeof vi.fn>
let listeners: Map<string, EventListener>
let deferStream: boolean
let pendingRequestId: string | null
let deferFirstLease: boolean
let rejectFirstLease: ((error: Error) => void) | null
let leaseRequestCount: number

beforeEach(() => {
  window.getSelection()?.removeAllRanges()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  listeners = new Map()
  deferStream = false
  pendingRequestId = null
  deferFirstLease = false
  rejectFirstLease = null
  leaseRequestCount = 0
  useProjectStore.setState({ currentProject: { id: 'editor-project', sessionLease: 'editor-epoch', path: 'C:/合成编辑器', novelConfig: {} } as never })
  useLLMStore.setState({
    defaultModelId: 'editor-model',
    loaded: true,
    activeRequests: new Map(),
  })
  const recoveries = new Map<string, unknown>()
  invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'editor-inline:begin') {
      leaseRequestCount += 1
      if (deferFirstLease && leaseRequestCount === 1) return new Promise((_resolve, reject) => { rejectFirstLease = reject })
      const input = (args[0] as { input: { documentText: string } }).input
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input.documentText))), byte => byte.toString(16).padStart(2, '0')).join('')
      const recovery = { view: { handle: { projectId: 'editor-project', epoch: 'editor-epoch', rootActionId: 'root', runId: `run-${leaseRequestCount}` }, status: 'running', artifacts: [] }, modelId: 'editor-model', sourceStatus: 'current', context: { ...input, kind: 'author-draft', documentHash: hash } }
      recoveries.set(recovery.view.handle.runId, recovery)
      return recovery
    }
    if (channel === 'editor-inline:read-recovery') return recoveries.get((args[0] as { handle: { runId: string } }).handle.runId)
    if (channel === 'generation:read') return { handle: args[0], status: 'running', artifacts: [] }
    if (channel === 'editor-inline:cancel') return { handle: (args[0] as { handle: object }).handle, status: 'cancelled', artifacts: [] }
    if (channel === 'editor-inline:execute') {
      const handle = (args[0] as { handle: object }).handle
      pendingRequestId = 'synthetic'
      return new Promise(resolve => {
        const finish = (data: { fullText: string; finishReason: string }) => {
          const snapshot = { ...handle, artifactId: 'proof', textHash: 'proof-hash', text: data.fullText, status: data.finishReason === 'stop' ? 'completed' : 'failed', compositionEligible: true }
          const run = { handle, status: snapshot.status, artifacts: [snapshot] }
          const stored = recoveries.get((handle as { runId: string }).runId) as { view: unknown }
          stored.view = run
          resolve({ run, outcome: { status: snapshot.status, content: data.fullText, finishReason: data.finishReason, receipt: { finishReason: data.finishReason } } })
        }
        listeners.set('llm:stream-done', finish as EventListener)
        if (!deferStream) queueMicrotask(() => finish({ fullText: '残缺片段', finishReason: 'length' }))
      })
    }
    throw new Error(`Unexpected IPC channel: ${channel}`)
  })
  Object.defineProperty(window, 'aiNovelAPI', {
    configurable: true,
    value: {
      invoke,
      on: vi.fn((channel: string, listener: EventListener) => {
        listeners.set(channel, listener)
        return () => listeners.delete(channel)
      }),
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
  useLLMStore.setState({ defaultModelId: null, activeRequests: new Map() })
  useLocaleStore.setState({ locale: 'zh-CN' })
  Reflect.deleteProperty(window, 'aiNovelAPI')
})

describe('CodeMirror editor AI generation boundary', () => {
  it('localizes search and AI-result actions for an English interface', async () => {
    useLocaleStore.setState({ locale: 'en-US' })
    await act(async () => root.render(
      <CodeMirrorEditor content="Original passage" mode="prose" />,
    ))

    const editor = container.querySelector<HTMLElement>('.cm-content')!
    await act(async () => {
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }))
    })
    await expect.element(page.getByRole('textbox', { name: 'Find' })).toBeVisible()
    await expect.element(page.getByRole('textbox', { name: 'Replace' })).toBeVisible()

    await act(async () => page.getByText('Original passage').click({ clickCount: 3 }))
    await act(async () => page.getByRole('button', { name: 'Refine' }).click())

    await expect.element(page.getByText('Refine preview')).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Cancel' })).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Replace', exact: true })).toBeDisabled()
  })

  it('keeps a length-limited main result non-applicable without a renderer model lease', async () => {
    await act(async () => root.render(
      <CodeMirrorEditor content="原文段落" mode="prose" />,
    ))

    await page.getByText('原文段落').click({ clickCount: 3 })

    await act(async () => page.getByRole('button', { name: '润色' }).click())

    await expect.element(page.getByText('生成未完整完成，结果不可应用')).toBeVisible()
    await expect.element(page.getByRole('button', { name: '替换' })).toBeDisabled()
    await expect.element(page.getByText('残缺片段')).not.toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('editor-inline:begin', expect.objectContaining({ input: expect.objectContaining({ action: 'refine', documentText: '原文段落' }) }), expect.any(Object))
    expect(invoke.mock.calls.some(([channel]) => String(channel).startsWith('llm:'))).toBe(false)

  })

  it('applies a delayed AI result to the frozen original selection instead of a later selection', async () => {
    deferStream = true
    await act(async () => root.render(
      <CodeMirrorEditor content="甲乙" mode="prose" />,
    ))
    const view = EditorView.findFromDOM(container.querySelector('.cm-editor')!)!

    await act(async () => page.getByText('甲乙').click({ clickCount: 3 }))
    await act(async () => page.getByRole('button', { name: '润色' }).click())
    await act(async () => view.dispatch({ selection: { anchor: 1, head: 2 } }))

    await act(async () => {
      const requestId = pendingRequestId!
      listeners.get('llm:stream-chunk')?.({ requestId, chunk: '替换甲' } as never)
      listeners.get('llm:stream-done')?.({
        requestId,
        fullText: '替换甲',
        finishReason: 'stop',
      } as never)
    })
    await expect.element(page.getByText('替换甲')).toBeVisible()
    await act(async () => page.getByRole('button', { name: '替换' }).click())

    expect(view.state.doc.toString()).toBe('替换甲')
  })

  it('keeps a delayed result copyable but refuses stale offsets after the document changes', async () => {
    deferStream = true
    await act(async () => root.render(
      <CodeMirrorEditor content="甲乙" mode="prose" />,
    ))
    const view = EditorView.findFromDOM(container.querySelector('.cm-editor')!)!

    await act(async () => page.getByText('甲乙').click({ clickCount: 3 }))
    await act(async () => page.getByRole('button', { name: '润色' }).click())
    await act(async () => view.dispatch({ changes: { from: 0, insert: '新' } }))

    await act(async () => {
      const requestId = pendingRequestId!
      listeners.get('llm:stream-done')?.({
        requestId,
        fullText: '替换甲',
        finishReason: 'stop',
      } as never)
    })
    await expect.element(page.getByText('替换甲')).toBeVisible()
    await act(async () => page.getByRole('button', { name: '替换' }).click())

    expect(view.state.doc.toString()).toBe('新甲乙')
    await expect.element(page.getByText('正文或原目标已变化，结果未应用；你仍可复制预览内容')).toBeVisible()
    await expect.element(page.getByText('替换甲')).toBeVisible()
  })

  it('keeps a completed result copyable but refuses replacement after the editor becomes read-only', async () => {
    deferStream = true
    await act(async () => root.render(
      <CodeMirrorEditor content="甲乙" mode="prose" editable />,
    ))
    const view = EditorView.findFromDOM(container.querySelector('.cm-editor')!)!

    await act(async () => page.getByText('甲乙').click({ clickCount: 3 }))
    await act(async () => page.getByRole('button', { name: '润色' }).click())
    await act(async () => {
      const requestId = pendingRequestId!
      listeners.get('llm:stream-done')?.({
        requestId,
        fullText: '替换甲',
        finishReason: 'stop',
      } as never)
    })
    await expect.element(page.getByText('替换甲')).toBeVisible()

    await act(async () => root.render(
      <CodeMirrorEditor content="甲乙" mode="prose" editable={false} />,
    ))
    await act(async () => page.getByRole('button', { name: '替换' }).click())

    expect(view.state.doc.toString()).toBe('甲乙')
    await expect.element(page.getByText('正文已变为只读，结果未应用；你仍可复制预览内容')).toBeVisible()
    await expect.element(page.getByText('替换甲')).toBeVisible()
  })

  it('keeps request B visible when cancelled request A fails after B succeeds', async () => {
    deferFirstLease = true
    deferStream = true
    await act(async () => root.render(
      <CodeMirrorEditor content="甲乙" mode="prose" />,
    ))
    const view = EditorView.findFromDOM(container.querySelector('.cm-editor')!)!

    await act(async () => page.getByText('甲乙').click({ clickCount: 3 }))
    await act(async () => page.getByRole('button', { name: '润色' }).click())
    await vi.waitFor(() => expect(rejectFirstLease).not.toBeNull())
    await act(async () => page.getByRole('button', { name: '取消' }).click())

    await act(async () => {
      view.dispatch({ selection: { anchor: 0 } })
      view.dispatch({ selection: { anchor: 0, head: 2 } })
    })
    await act(async () => page.getByRole('button', { name: '润色' }).click())
    await vi.waitFor(() => expect(pendingRequestId).not.toBeNull())
    await act(async () => {
      listeners.get('llm:stream-done')?.({
        requestId: pendingRequestId!,
        fullText: 'B 的结果',
        finishReason: 'stop',
      } as never)
    })
    await expect.element(page.getByText('B 的结果')).toBeVisible()

    await act(async () => rejectFirstLease!(new Error('A late failure')))

    await expect.element(page.getByText('B 的结果')).toBeVisible()
    await expect.element(page.getByText('生成失败，结果不可应用')).not.toBeInTheDocument()
  })
})

it.each([false, true])('明确 handle 恢复原候选；文件改变=%s 时只复制不替换', async changedFile => {
  const handle = { projectId: 'editor-project', epoch: 'editor-epoch', rootActionId: '原预算', runId: '原候选' }
  const documentText = '甲😀乙'
  const documentHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(documentText))), byte => byte.toString(16).padStart(2, '0')).join('')
  invoke.mockImplementation(async (channel: string) => {
    if (channel !== 'editor-inline:read-recovery') throw new Error('恢复不可创建或执行新请求:' + channel)
    return { view: { handle, status: 'completed', artifacts: [{ ...handle, artifactId: '原artifact', textHash: 'proof-hash', text: '替换表情', status: 'completed', compositionEligible: true }] }, modelId: '原模型', sourceStatus: 'current', context: { action: 'refine', kind: 'author-draft', documentText, documentHash, from: 1, to: 3, selectedText: '😀' } }
  })
  useLLMStore.setState({ defaultModelId: null })
  await act(async () => root.render(<CodeMirrorEditor content={documentText} filePath="ai-novel://draft/1" recoveryHandle={handle} />))
  await expect.element(page.getByText('替换表情')).toBeVisible()
  if (changedFile) await act(async () => root.render(<CodeMirrorEditor content={documentText} filePath="ai-novel://draft/2" recoveryHandle={handle} />))
  await act(async () => page.getByRole('button', { name: '替换' }).click())
  const view = EditorView.findFromDOM(container.querySelector('.cm-editor')!)!
  expect(view.state.doc.toString()).toBe(changedFile ? documentText : '甲替换表情乙')
  if (changedFile) await expect.element(page.getByText('正文或原目标已变化，结果未应用；你仍可复制预览内容')).toBeVisible()
  expect(invoke).toHaveBeenCalledTimes(2)
})

it('取消调用 main；卸载仅脱离且已交付明确恢复 handle', async () => {
  deferStream = true
  const navigation = vi.fn()
  await act(async () => root.render(<CodeMirrorEditor content="甲乙" onGenerationHandle={navigation} />))
  await act(async () => page.getByText('甲乙').click({ clickCount: 3 }))
  await act(async () => page.getByRole('button', { name: '润色' }).click())
  await vi.waitFor(() => expect(navigation).toHaveBeenCalledTimes(1))
  await act(async () => page.getByRole('button', { name: '取消' }).click())
  await vi.waitFor(() => expect(invoke.mock.calls.filter(([channel]) => channel === 'editor-inline:cancel')).toHaveLength(1))
  await act(async () => root.render(<div />))
  expect(invoke.mock.calls.filter(([channel]) => channel === 'editor-inline:cancel')).toHaveLength(1)
})
it('接受前 main 重读等待期间正文变化，仍保留作者新文稿', async () => {
  const handle = { projectId: 'editor-project', epoch: 'editor-epoch', rootActionId: '原预算', runId: 'CAS运行' }
  const documentText = '原文'
  const documentHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(documentText))), byte => byte.toString(16).padStart(2, '0')).join('')
  const stored = { view: { handle, status: 'completed', artifacts: [{ ...handle, artifactId: 'proof', textHash: 'proof-hash', text: '候选', status: 'completed', compositionEligible: true }] }, modelId: '原模型', sourceStatus: 'current', context: { action: 'refine', kind: 'author-draft', documentText, documentHash, from: 0, to: 2, selectedText: documentText } }
  let reads = 0
  let resolve!: (value: unknown) => void
  invoke.mockImplementation(async () => ++reads === 1 ? stored : new Promise(r => { resolve = r }))
  await act(async () => root.render(<CodeMirrorEditor content={documentText} recoveryHandle={handle} />))
  await expect.element(page.getByText('候选')).toBeVisible()
  await act(async () => page.getByRole('button', { name: '替换' }).click())
  const view = EditorView.findFromDOM(container.querySelector('.cm-editor')!)!
  await act(async () => { view.dispatch({ changes: { from: 0, insert: '新' } }); resolve(stored) })
  await expect.element(page.getByText('正文或原目标已变化，结果未应用；你仍可复制预览内容')).toBeVisible()
  expect(view.state.doc.toString()).toBe('新原文')
})
it.each(['unknown', 'discarded'])('已有 %s 请求占用时不显示重新执行入口', async status => {
  const handle = { projectId: 'editor-project', epoch: 'editor-epoch', rootActionId: '原预算', runId: '占用运行' }
  const documentText = '原文'
  const documentHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(documentText))), byte => byte.toString(16).padStart(2, '0')).join('')
  invoke.mockImplementation(async () => ({ view: { handle, status, artifacts: [], candidates: [], ledger: { physicalRequests: 1 } }, modelId: '原模型', sourceStatus: 'current', context: { action: 'refine', kind: 'author-draft', documentText, documentHash, from: 0, to: 2, selectedText: documentText } }))
  await act(async () => root.render(<CodeMirrorEditor content={documentText} recoveryHandle={handle} />))
  await expect.element(page.getByText('恢复的候选尚不可应用，可复制或继续原运行')).toBeVisible()
  await expect.element(page.getByRole('button', { name: '继续原运行' })).not.toBeInTheDocument()
  expect(invoke).toHaveBeenCalledTimes(1)
})
it('点击接受前原候选已丢弃，保留预览但不写入正文', async () => {
  const handle = { projectId: 'editor-project', epoch: 'editor-epoch', rootActionId: '原预算', runId: '丢弃运行' }
  const documentText = '原文'
  const documentHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(documentText))), byte => byte.toString(16).padStart(2, '0')).join('')
  const proof = { ...handle, artifactId: 'proof', textHash: 'proof-hash', text: '候选', status: 'completed', compositionEligible: true }
  let reads = 0
  invoke.mockImplementation(async () => ({ view: { handle, status: 'completed', artifacts: ++reads === 1 ? [proof] : [] }, modelId: '原模型', sourceStatus: 'current', context: { action: 'refine', kind: 'author-draft', documentText, documentHash, from: 0, to: 2, selectedText: documentText } }))
  await act(async () => root.render(<CodeMirrorEditor content={documentText} recoveryHandle={handle} />))
  await expect.element(page.getByText('候选')).toBeVisible()
  await act(async () => page.getByRole('button', { name: '替换' }).click())
  await expect.element(page.getByText('来源已变化，结果仅可复制')).toBeVisible()
  expect(EditorView.findFromDOM(container.querySelector('.cm-editor')!)!.state.doc.toString()).toBe(documentText)
  await expect.element(page.getByText('候选')).toBeVisible()
})
