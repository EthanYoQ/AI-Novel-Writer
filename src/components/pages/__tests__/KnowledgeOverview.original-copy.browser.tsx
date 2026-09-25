import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import KnowledgeOverview from '../KnowledgeOverview'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const project = { id: 'copy-project', name: 'Copy project', path: 'C:/novels/copy-project', sessionLease: 'copy-lease', novelConfig: { writingLanguage: 'en-US' } }
const previousProject = useProjectStore.getState()
const previousLocale = useLocaleStore.getState()
const previousAPI = Object.getOwnPropertyDescriptor(window, 'aiNovelAPI')

afterEach(() => {
  useProjectStore.setState(previousProject)
  useLocaleStore.setState(previousLocale)
  if (previousAPI) Object.defineProperty(window, 'aiNovelAPI', previousAPI)
  else Reflect.deleteProperty(window, 'aiNovelAPI')
})

it('opens a project copy, saves and reopens it, then explicitly updates its local index', async () => {
  let content = 'Full original text'
  let edited = false
  let currentId = 'doc-1'
  let indexStatus = 'current' as 'current' | 'stale'
  let finishSave!: () => void
  const saveGate = new Promise<void>(resolve => { finishSave = resolve })
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'kb:list-documents') return [{ id: currentId, fileName: 'source.txt', importedAt: '2026-09-25', chunkCount: 1, filePath: `knowledge-copy:${currentId}` }]
    if (channel === 'kb:stats') return { documentCount: 1, totalChunks: 1, vectorDimension: 0 }
    if (channel === 'kb:get-vector-rebuild-status') return { embeddingConfigured: false, canRebuild: false, totalChunks: 1, vectorlessCount: 1, activeVectorDimension: 0 }
    if (channel === 'kb:read-document-copy') return { available: true, content, contentHash: content, edited, indexStatus }
    if (channel === 'kb:save-document-copy') {
      expect(args[0]).toBe(currentId)
      expect(args[2]).toBe(content)
      await saveGate
      content = args[1] as string
      edited = true
      indexStatus = 'stale'
      return { success: true }
    }
    if (channel === 'kb:reindex-document-copy') {
      currentId = 'doc-2'
      indexStatus = 'current'
      return { success: true, docId: currentId, chunkCount: 1 }
    }
    throw new Error(`Unexpected IPC channel: ${channel}`)
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => {}, once: () => {}, send: () => {} } })
  useLocaleStore.setState({ locale: 'en-US', initialized: true })
  useProjectStore.setState({ currentProject: project as never })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<KnowledgeOverview />))
    await vi.waitFor(() => expect(page.getByRole('button', { name: 'source.txt' }).query()).not.toBeNull())
    await act(async () => page.getByRole('button', { name: 'source.txt' }).click())
    await vi.waitFor(() => expect((page.getByRole('textbox', { name: 'Project copy content' }).query() as HTMLTextAreaElement).value).toBe('Full original text'))
    await act(async () => page.getByRole('textbox', { name: 'Project copy content' }).fill('Edited project copy'))
    await act(async () => page.getByRole('button', { name: 'Save project copy' }).click())
    await vi.waitFor(() => expect((page.getByRole('textbox', { name: 'Project copy content' }).query() as HTMLTextAreaElement).disabled).toBe(true))
    await act(async () => finishSave())
    await vi.waitFor(() => expect(container.textContent).toContain('Index update needed'))
    await act(async () => page.getByRole('button', { name: 'source.txt' }).click())
    await vi.waitFor(() => expect((page.getByRole('textbox', { name: 'Project copy content' }).query() as HTMLTextAreaElement).value).toBe('Edited project copy'))
    await act(async () => page.getByRole('button', { name: 'Update local text index' }).click())
    await vi.waitFor(() => expect(container.textContent).not.toContain('Index update needed'))
    expect(invoke).toHaveBeenCalledWith('kb:reindex-document-copy', 'doc-1', project.path, expect.anything())
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})

it('unlocks the next project while the previous project save is still pending', async () => {
  const nextProject = { ...project, id: 'next-project', path: 'C:/novels/next-project', sessionLease: 'next-lease' }
  let finishSave!: () => void
  const saveGate = new Promise<{ success: true }>(resolve => { finishSave = () => resolve({ success: true }) })
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    const next = args.includes(nextProject.path)
    if (channel === 'kb:list-documents') return [{ id: next ? 'next-doc' : 'old-doc', fileName: next ? 'next.txt' : 'old.txt', importedAt: '2026-09-25', chunkCount: 1, filePath: 'knowledge-copy:doc' }]
    if (channel === 'kb:stats') return { documentCount: 1, totalChunks: 1, vectorDimension: 0 }
    if (channel === 'kb:get-vector-rebuild-status') return { embeddingConfigured: false, canRebuild: false, totalChunks: 1, vectorlessCount: 1, activeVectorDimension: 0 }
    if (channel === 'kb:read-document-copy') return { available: true, content: next ? 'Next project' : 'Old project', contentHash: 'fixture-hash', edited: false, indexStatus: 'current' }
    if (channel === 'kb:save-document-copy') return saveGate
    throw new Error(`Unexpected IPC channel: ${channel}`)
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => {}, once: () => {}, send: () => {} } })
  useLocaleStore.setState({ locale: 'en-US', initialized: true })
  useProjectStore.setState({ currentProject: project as never })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<KnowledgeOverview />))
    await vi.waitFor(() => expect(page.getByRole('button', { name: 'old.txt' }).query()).not.toBeNull())
    await act(async () => page.getByRole('button', { name: 'old.txt' }).click())
    await vi.waitFor(() => expect(page.getByRole('textbox', { name: 'Project copy content' }).query()).not.toBeNull())
    await act(async () => page.getByRole('textbox', { name: 'Project copy content' }).fill('Old project changed'))
    await act(async () => page.getByRole('button', { name: 'Save project copy' }).click())
    await vi.waitFor(() => expect((page.getByRole('textbox', { name: 'Project copy content' }).query() as HTMLTextAreaElement).disabled).toBe(true))

    await act(async () => useProjectStore.setState({ currentProject: nextProject as never }))
    await vi.waitFor(() => expect((page.getByRole('button', { name: 'next.txt' }).query() as HTMLButtonElement).disabled).toBe(false))
    await act(async () => page.getByRole('button', { name: 'next.txt' }).click())
    await vi.waitFor(() => expect((page.getByRole('textbox', { name: 'Project copy content' }).query() as HTMLTextAreaElement).value).toBe('Next project'))
    await act(async () => finishSave())
    expect((page.getByRole('textbox', { name: 'Project copy content' }).query() as HTMLTextAreaElement).value).toBe('Next project')
  } finally {
    finishSave()
    await act(async () => root.unmount())
    container.remove()
  }
})
