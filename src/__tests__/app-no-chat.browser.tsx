import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { StoreApi } from 'zustand'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from '../App'
import type { Locale } from '../i18n/types'
import type { ProjectData } from '../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../shared/project-session-context'
import { useLayoutStore } from '../stores/layout-store'
import { useLocaleStore } from '../stores/locale-store'
import { navigate } from '../stores/navigation/navigation-intents'
import { useProjectStore } from '../stores/project-store'
import { useWorkflowStore } from '../stores/workflow-store'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CHAT_WORDS = /Agent|助手|聊天|对话|assistant|chat/i
const session = { projectId: '灯塔', projectPath: 'C:/novels/lighthouse', leaseId: '本次打开' }
const project = { id: session.projectId, name: '灯塔', path: session.projectPath, sessionLease: session.leaseId, novelConfig: {
  coreOutline: '', genre: '', subGenre: '', targetAudience: '', totalChapters: 24, wordsPerChapter: 3000, worldSetting: '', goldenFinger: '',
  protagonistProfile: '', globalGuidance: '', writingStyle: '', referenceWorks: '', narrativePOV: 'third_limited', plotStructure: 'three_act', writingLanguage: 'zh-CN',
} } as unknown as ProjectData

const restores = [useLayoutStore, useLocaleStore, useProjectStore, useWorkflowStore].map(store => {
  const state = (store as StoreApi<unknown>).getState()
  return () => (store as StoreApi<unknown>).setState(state, true)
})

let configLocale: Locale
let host: HTMLDivElement
let root: Root
let invoke: ReturnType<typeof vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>>

/** 主进程的回复按渠道给出最小的合法形状；列表类给空列表。 */
function reply(channel: string): unknown {
  if (channel === 'config:get') return { locale: configLocale }
  if (channel === 'project:smoke-open-request') return null
  if (/list|history|models/i.test(channel)) return []
  if (channel === 'fs:check-exists') return false
  return { success: true }
}

beforeEach(() => {
  configLocale = 'zh-CN'
  invoke = vi.fn(async (channel: string) => reply(channel))
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => {}, once: () => {}, send: () => {} } })
  useProjectStore.setState({ currentProject: project })
  setActiveProjectSessionContext(session)
  useLayoutStore.setState({ sidebarView: 'project' })
  useWorkflowStore.setState({ activeRuns: [], history: [] })
  host = document.createElement('div')
  host.style.cssText = 'width: 1440px; height: 900px; display: flex'
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  setActiveProjectSessionContext(null)
  for (const restore of restores) restore()
  vi.restoreAllMocks()
  delete window.aiNovelAPI
})

describe('应用里没有 AI 聊天', () => {
  it.each<Locale>(['zh-CN', 'en-US'])('%s：作品里的界面与运行侧页都没有聊天入口', async locale => {
    configLocale = locale
    useLocaleStore.setState({ locale })
    await act(async () => root.render(<App />))
    await vi.waitFor(() => expect(host.querySelector('.stage-shell')).not.toBeNull())
    await act(async () => navigate({ kind: 'run', facet: 'output' }))
    await vi.waitFor(() => expect(host.querySelector('.stage-sheet-slot')).not.toBeNull())
    expect(host.textContent).not.toMatch(CHAT_WORDS)
    expect([...host.querySelectorAll('[aria-label],[title],[placeholder]')]
      .map(node => ['aria-label', 'title', 'placeholder'].map(name => node.getAttribute(name) ?? '').join(' ')).join(' ')).not.toMatch(CHAT_WORDS)
  })

  it('启动时不连接 MCP 服务器', async () => {
    await act(async () => root.render(<App />))
    await vi.waitFor(() => expect(invoke.mock.calls.map(([channel]) => channel)).toContain('project:recent-list'))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
    expect(invoke.mock.calls.map(([channel]) => channel).filter(channel => channel.startsWith('mcp:'))).toEqual([])
  })
})
