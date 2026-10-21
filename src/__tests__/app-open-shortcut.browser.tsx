import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { StoreApi } from 'zustand'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from '../App'
import { useEditorStore } from '../stores/editor-store'
import { useLayoutStore } from '../stores/layout-store'
import { useLLMStore } from '../stores/llm-store'
import { useLocaleStore } from '../stores/locale-store'
import { useStageStore } from '../stores/navigation/stage-store'
import { useProjectStore } from '../stores/project-store'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SKILL_URL = 'https://github.com/owner/skill'
const restores = [useEditorStore, useLayoutStore, useLLMStore, useLocaleStore, useStageStore, useProjectStore].map(store => {
  const state = (store as StoreApi<unknown>).getState()
  return () => (store as StoreApi<unknown>).setState(state, true)
})

let host: HTMLDivElement
let root: Root
let invoke: ReturnType<typeof vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>>

const discardDialog = () => [...document.querySelectorAll('[role="dialog"]')].find(dialog => dialog.querySelector('h2')?.textContent === '放弃未保存的修改？')
const dialogButton = (name: string) => [...discardDialog()!.querySelectorAll('button')].find(button => button.textContent === name)
const skillUrl = () => host.querySelector<HTMLInputElement>('input[aria-label="GitHub Skill 地址"]')
const calls = (channel: string) => invoke.mock.calls.filter(([called]) => called === channel)
const pressCtrlO = () => act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', code: 'KeyO', ctrlKey: true, bubbles: true, cancelable: true })) })

async function typeSkillUrl(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(skillUrl(), value)
    skillUrl()!.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(async () => {
  // 主进程的回复按渠道给出最小的合法形状（同 app-no-chat）；选文件夹回 null，即作者取消了选择。
  // App 挂载时按 config 的 locale 初始化语言，缺省就跟系统语言走，英文系统的 CI 上会渲染成英文。
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'config:get') return { locale: 'zh-CN' }
    if (channel === 'project:smoke-open-request' || channel === 'dialog:select-folder') return null
    if (/list|history|models/i.test(channel)) return []
    if (channel === 'fs:check-exists') return false
    return { success: true }
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => undefined, once: () => undefined, send: () => undefined } })
  useLocaleStore.setState({ locale: 'zh-CN' })
  useLLMStore.setState({ loaded: true, models: [], defaultModelId: null })
  useEditorStore.setState({ tabs: [], activeTabId: null })
  useStageStore.setState({ sheet: null, focus: false, palette: null, work: null })
  useProjectStore.setState({ currentProject: null, recentProjects: [] })
  useLayoutStore.setState({ sidebarView: 'project', settingsOpen: true, settingsSection: 'skills' })
  host = document.createElement('div')
  host.style.cssText = 'width: 1280px; height: 800px; display: flex;'
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<App />))
  await vi.waitFor(() => expect(skillUrl()).toBeTruthy())
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  Reflect.deleteProperty(window, 'aiNovelAPI')
  for (const restore of restores) restore()
})

describe('设置页开着时按 Ctrl O 打开作品，选文件夹时取消', () => {
  it('有没保存的输入：先问放弃，放弃后才弹选文件夹；取消选择后设置页与输入都留着', async () => {
    await typeSkillUrl(SKILL_URL)
    await pressCtrlO()
    expect(discardDialog()).toBeTruthy()
    expect(calls('dialog:select-folder')).toEqual([])
    await act(async () => dialogButton('放弃修改')!.click())
    await vi.waitFor(() => expect(calls('dialog:select-folder')).toHaveLength(1))
    expect(useLayoutStore.getState().settingsOpen).toBe(true)
    expect(skillUrl()?.value).toBe(SKILL_URL)
    expect(calls('project:open')).toEqual([])
  })

  it('没有没保存的输入：不问，直接弹选文件夹；取消后设置页留着', async () => {
    await pressCtrlO()
    await vi.waitFor(() => expect(calls('dialog:select-folder')).toHaveLength(1))
    expect(discardDialog()).toBeUndefined()
    expect(useLayoutStore.getState().settingsOpen).toBe(true)
    expect(skillUrl()).toBeTruthy()
  })
})
