import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { useEditorStore } from '../../../stores/editor-store'
import VersionHistory from '../VersionHistory'

const projectPath = 'C:/合成小说/版本比较'
const session = { projectId: '版本比较', leaseId: '租约一', projectPath }
let host: HTMLDivElement
let root: Root
let invoke: ReturnType<typeof vi.fn>
const originalProject = useProjectStore.getState()
const originalLocale = useLocaleStore.getState()
const originalEditor = useEditorStore.getState()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
beforeEach(() => {
  useLocaleStore.setState({ locale: 'zh-CN', initialized: true })
  useProjectStore.setState({ currentProject: { id: session.projectId, path: projectPath, name: '合成小说', sessionLease: session.leaseId, novelConfig: {} } as never })
  useEditorStore.setState({ tabs: [], activeTabId: null })
  setActiveProjectSessionContext(session)
  invoke = vi.fn(async (channel: string, id?: number) => {
    if (channel === 'db:blueprint-get-all') return [{ chapterNumber: 1, title: '雨夜来信' }]
    if (channel === 'db:draft-list') return [{ id: 1, version: 1, status: 'draft', wordCount: 900, createdAt: '2026-09-13T00:00:00Z' }]
    if (channel === 'db:draft-get-full') return { content: id === 1 ? '旧版中文正文。' : '新版中文正文。' }
    if (channel === 'db:draft-get-latest') return { id: 2 }
    throw new Error('未预期IPC')
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: vi.fn(() => () => {}), once: vi.fn(), send: vi.fn() } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); Reflect.deleteProperty(window, 'aiNovelAPI')
  setActiveProjectSessionContext(null); useProjectStore.setState(originalProject); useLocaleStore.setState(originalLocale); useEditorStore.setState(originalEditor)
})
it('中文历史比较通过新桥接打开规范URI并保留两份原文', async () => {
  await act(async () => root.render(<VersionHistory projectKey={projectPath} />))
  await vi.waitFor(() => expect(host.textContent).toContain('雨夜来信'))
  await act(async () => host.querySelector<HTMLElement>('.cursor-pointer')?.click())
  await vi.waitFor(() => expect(host.querySelector('[title="与当前版本对比"]')).not.toBeNull())
  await act(async () => host.querySelector<HTMLElement>('[title="与当前版本对比"]')?.click())
  await vi.waitFor(() => expect(useEditorStore.getState().tabs).toHaveLength(1))
  expect(useEditorStore.getState().tabs[0]).toMatchObject({ type: 'diff', filePath: 'ai-novel://draft/ch1', originalContent: '旧版中文正文。', content: '新版中文正文。', projectKey: projectPath })
})
