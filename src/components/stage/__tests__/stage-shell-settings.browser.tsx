import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import '../../../index.css'
import '../../../styles/paper-ink/index.css'
import '../stage.css'
import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import { useEditorStore } from '../../../stores/editor-store'
import { useLayoutStore } from '../../../stores/layout-store'
import { useLLMStore } from '../../../stores/llm-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useStageStore } from '../../../stores/navigation/stage-store'
import { useProjectStore } from '../../../stores/project-store'
import { toast } from '../../ui/Toast'
import StageShell from '../StageShell'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function snapshot<T>(store: StoreApi<T>): () => void {
  const state = store.getState()
  return () => store.setState(state, true)
}
const restores = [useEditorStore, useLayoutStore, useLLMStore, useLocaleStore, useStageStore, useProjectStore]
  .map(store => snapshot(store as StoreApi<unknown>))

const TARGET = 'C:\\novels\\harbor-copy'

let root: Root | undefined
let host: HTMLDivElement | undefined
let invoke: ReturnType<typeof vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>>

const discardDialog = () => [...document.querySelectorAll('[role="dialog"]')].find(dialog => dialog.querySelector('h2')?.textContent === '放弃未保存的修改？')
const dialogButton = (name: string) => [...discardDialog()!.querySelectorAll('button')].find(button => button.textContent === name)
const skillUrl = () => host!.querySelector<HTMLInputElement>('input[aria-label="GitHub Skill 地址"]')!
const opens = () => invoke.mock.calls.filter(([channel]) => channel === 'project:open')
const paletteOption = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent?.includes(name))!

beforeEach(async () => {
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'config:get') return {}
    if (channel === 'dialog:select-legacy-project') return { grantId: 'legacy-grant', displayName: '旧港' }
    if (channel === 'dialog:select-project-restore-target') return { grantId: 'target-grant' }
    if (channel === 'project:import-legacy-copy') return { state: 'ready', projectId: 'harbor', targetRoot: TARGET }
    if (channel === 'project:open') return { success: false, error: '测试里不真的打开' }
    return channel.endsWith('-list') || channel.endsWith('get-all') ? [] : undefined
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => undefined } })
  useLocaleStore.setState({ locale: 'zh-CN' })
  useLLMStore.setState({ loaded: true, models: [], defaultModelId: null })
  useEditorStore.setState({ tabs: [], activeTabId: null })
  useStageStore.setState({ sheet: null, focus: false, palette: null, work: null })
  useProjectStore.setState({ currentProject: null, recentProjects: [], legacyImportNotice: '' })
  useLayoutStore.setState({ sidebarView: 'project', settingsOpen: true, settingsSection: 'skills' })
  host = document.createElement('div')
  host.style.cssText = 'width: 1280px; height: 800px; display: flex;'
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<StageShell theme="light" />))
  await vi.waitFor(() => expect(skillUrl()).toBeTruthy())
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(skillUrl(), 'https://github.com/owner/skill')
    skillUrl().dispatchEvent(new Event('input', { bubbles: true }))
  })
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  Reflect.deleteProperty(window, 'aiNovelAPI')
  setActiveProjectSessionContext(null)
  for (const restore of restores) restore()
  vi.restoreAllMocks()
})

describe('书房里的设置页有没保存的输入时，导入旧项目副本完成后要自动打开作品', () => {
  it('先确认放弃；继续编辑时不打开，设置页与输入都留着，提示副本已建立', async () => {
    let importing!: Promise<boolean>
    await act(async () => { importing = useProjectStore.getState().importLegacyProject() })
    await vi.waitFor(() => expect(discardDialog()?.textContent).toContain('这一页有还没保存的修改，离开后会丢失。'))
    expect(opens()).toEqual([])
    await act(async () => dialogButton('继续编辑')!.click())
    await expect(importing).resolves.toBe(false)
    expect(opens()).toEqual([])
    expect(useLayoutStore.getState().settingsOpen).toBe(true)
    expect(skillUrl().value).toBe('https://github.com/owner/skill')
    expect(useProjectStore.getState().legacyImportNotice).toBe(`副本已建立。你选了继续编辑设置，所以没有自动打开；之后可用“打开作品”选择：${TARGET}`)
  })

  it('命令面板「打开作品」先问放弃，再弹选文件夹；继续编辑就不弹', async () => {
    await act(async () => useStageStore.setState({ palette: 'commands' }))
    const option = await vi.waitFor(() => {
      const found = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(candidate => candidate.textContent?.includes('打开作品'))
      expect(found).toBeTruthy()
      return found!
    })
    await act(async () => option.click())
    expect(discardDialog()).toBeTruthy()
    expect(invoke.mock.calls.filter(([channel]) => channel === 'dialog:select-folder')).toEqual([])
    await act(async () => dialogButton('继续编辑')!.click())
    expect(invoke.mock.calls.filter(([channel]) => channel === 'dialog:select-folder')).toEqual([])
    expect(skillUrl().value).toBe('https://github.com/owner/skill')
  })

  describe('从命令面板「打开作品」，选文件夹时取消', () => {
    const folderDialogs = () => invoke.mock.calls.filter(([channel]) => channel === 'dialog:select-folder')
    async function openFromPalette() {
      await act(async () => useStageStore.setState({ palette: 'commands' }))
      await act(async () => paletteOption('打开作品').click())
    }

    it('没有没保存的输入：设置页留着', async () => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(skillUrl(), '')
        skillUrl().dispatchEvent(new Event('input', { bubbles: true }))
      })
      await openFromPalette()
      await vi.waitFor(() => expect(folderDialogs()).toHaveLength(1))
      expect(discardDialog()).toBeUndefined()
      expect(useLayoutStore.getState().settingsOpen).toBe(true)
      expect(skillUrl()).toBeTruthy()
    })

    it('选了放弃修改再取消选文件夹：设置页与输入都留着', async () => {
      await openFromPalette()
      await act(async () => dialogButton('放弃修改')!.click())
      await vi.waitFor(() => expect(folderDialogs()).toHaveLength(1))
      expect(useLayoutStore.getState().settingsOpen).toBe(true)
      expect(skillUrl().value).toBe('https://github.com/owner/skill')
      expect(opens()).toEqual([])
    })

    it('选了放弃修改并选到文件夹：收起设置页，打开选到的作品，只问一次', async () => {
      const plain = invoke.getMockImplementation()!
      invoke.mockImplementation(async (channel: string, ...args: unknown[]) => channel === 'dialog:select-folder' ? TARGET : plain(channel, ...args))
      await openFromPalette()
      await act(async () => dialogButton('放弃修改')!.click())
      await vi.waitFor(() => expect(opens().map(([, path]) => path)).toEqual([TARGET]))
      expect(useLayoutStore.getState().settingsOpen).toBe(false)
      expect(discardDialog()).toBeUndefined()
    })
  })

  it('确认框开着时又点了新建作品，原来的导入照样收尾：继续编辑后导入不再占着，也不弹新建', async () => {
    let importing!: Promise<boolean>
    await act(async () => { importing = useProjectStore.getState().importLegacyProject() })
    await vi.waitFor(() => expect(discardDialog()).toBeTruthy())
    await act(async () => useStageStore.setState({ palette: 'commands' }))
    await act(async () => paletteOption('新建作品').click())
    await act(async () => dialogButton('继续编辑')!.click())
    const stillWaiting = new Promise(resolve => setTimeout(() => resolve('导入还在等确认'), 1000))
    await expect(Promise.race([importing, stillWaiting])).resolves.toBe(false)
    expect(useProjectStore.getState().legacyImportBusy).toBe(false)
    expect(useLayoutStore.getState().newProjectOpen).toBe(false)
    expect(skillUrl().value).toBe('https://github.com/owner/skill')
  })

  it('选放弃修改才收起设置页并打开作品', async () => {
    await act(async () => { void useProjectStore.getState().importLegacyProject() })
    await vi.waitFor(() => expect(discardDialog()).toBeTruthy())
    await act(async () => dialogButton('放弃修改')!.click())
    await vi.waitFor(() => expect(opens().map(([, path]) => path)).toEqual([TARGET]))
    expect(useLayoutStore.getState().settingsOpen).toBe(false)
  })
})

describe('不是作者点的打开作品（外部打开请求、新建或导入完成后自动打开），书房里的设置页有没保存的输入', () => {
  it('先确认放弃；继续编辑就不打开，设置页与输入都留着', async () => {
    let opening!: Promise<boolean>
    await act(async () => { opening = useProjectStore.getState().openProject(TARGET) })
    await vi.waitFor(() => expect(discardDialog()?.textContent).toContain('这一页有还没保存的修改，离开后会丢失。'))
    expect(opens()).toEqual([])
    await act(async () => dialogButton('继续编辑')!.click())
    await expect(opening).resolves.toBe(false)
    expect(opens()).toEqual([])
    expect(useLayoutStore.getState().settingsOpen).toBe(true)
    expect(skillUrl().value).toBe('https://github.com/owner/skill')
  })

  it('选放弃修改才收起设置页并打开，只问一次', async () => {
    await act(async () => { void useProjectStore.getState().openProject(TARGET) })
    await vi.waitFor(() => expect(discardDialog()).toBeTruthy())
    await act(async () => dialogButton('放弃修改')!.click())
    await vi.waitFor(() => expect(opens().map(([, target]) => target)).toEqual([TARGET]))
    expect(useLayoutStore.getState().settingsOpen).toBe(false)
    expect(discardDialog()).toBeUndefined()
  })

  it('确认框开着时又来一个打开请求：新请求不打开，也不让原请求失效，选放弃修改后打开原来那部', async () => {
    const OTHER = 'C:\\novels\\other'
    await act(async () => { void useProjectStore.getState().openProject(TARGET) })
    await vi.waitFor(() => expect(discardDialog()).toBeTruthy())
    let second!: Promise<boolean>
    await act(async () => { second = useProjectStore.getState().openProject(OTHER) })
    await expect(second).resolves.toBe(false)
    await act(async () => dialogButton('放弃修改')!.click())
    await vi.waitFor(() => expect(opens().map(([, target]) => target)).toEqual([TARGET]))
  })
})

describe('放弃确认开着时又来了离开请求', () => {
  const toastTitles = () => [...document.querySelectorAll('.pi-toast-title')].map(node => node.textContent)

  it('作者又点了新建作品：提示先处理开着的确认，原来的确认还在', async () => {
    await act(async () => useStageStore.setState({ palette: 'commands' }))
    await act(async () => paletteOption('打开作品').click())
    expect(discardDialog()).toBeTruthy()
    await act(async () => useStageStore.setState({ palette: 'commands' }))
    await act(async () => paletteOption('新建作品').click())
    await vi.waitFor(() => expect(toastTitles()).toContain('请先处理「放弃未保存的修改？」'))
    expect(discardDialog()).toBeTruthy()
    expect(useLayoutStore.getState().newProjectOpen).toBe(false)
  })

  it('导入完成要自动打开作品：不打开，提示写明是另一个确认还开着，不说作者选了继续编辑', async () => {
    await act(async () => useStageStore.setState({ palette: 'commands' }))
    await act(async () => paletteOption('打开作品').click())
    expect(discardDialog()).toBeTruthy()
    const info = vi.spyOn(toast, 'info')
    let importing!: Promise<boolean>
    await act(async () => { importing = useProjectStore.getState().importLegacyProject() })
    await expect(importing).resolves.toBe(false)
    expect(opens()).toEqual([])
    expect(useProjectStore.getState().legacyImportNotice)
      .toBe(`副本已建立。另一个「放弃未保存的修改？」确认还开着，所以没有自动打开；之后可用“打开作品”选择：${TARGET}`)
    expect(info).not.toHaveBeenCalled()
    expect(discardDialog()).toBeTruthy()
  })
})
