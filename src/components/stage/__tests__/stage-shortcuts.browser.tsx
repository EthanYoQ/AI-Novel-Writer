/* eslint-disable react-refresh/only-export-components */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import '../../../index.css'
import '../../../styles/paper-ink/index.css'
import '../stage.css'
import { registerEditorExitSaveHandler, useEditorStore } from '../../../stores/editor-store'
import { useLayoutStore } from '../../../stores/layout-store'
import { useStageStore } from '../../../stores/navigation/stage-store'
import StagePalette from '../StagePalette'
import type { PaletteItem } from '../palette-filter'
import { commandLabel, isCommand } from '../shortcut-keys'
import { useStageShortcuts } from '../use-stage-shortcuts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PROJECT = 'C:\\novels\\stage-keys'
const layoutDefaults = useLayoutStore.getState()
let root: Root | undefined
let host: HTMLDivElement | undefined

function Shortcuts(props: { library: boolean; focus: boolean; mac?: boolean }) {
  useStageShortcuts({ ...props, mac: props.mac ?? false })
  return null
}

async function mount(element: ReactElement) {
  host = document.createElement('div')
  host.className = 'paper-ink stage-shell'
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(element))
}

/** 在 target 上派发一次按键，返回事件；一路冒泡到 window，和真实按键经过的监听器相同。 */
function press(target: EventTarget, init: KeyboardEventInit & { keyCode?: number }) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  if (init.keyCode !== undefined) Object.defineProperty(event, 'keyCode', { value: init.keyCode })
  act(() => { target.dispatchEvent(event) })
  return event
}

const ctrl = (key: string) => ({ key, code: `Key${key.toUpperCase()}`, ctrlKey: true })
const meta = (key: string) => ({ key, code: `Key${key.toUpperCase()}`, metaKey: true })

function openTab(id: string, dirty = false) {
  useEditorStore.getState().openFile({ id, name: id, type: 'config', projectKey: PROJECT })
  if (dirty) useEditorStore.getState().updateTabContent(useEditorStore.getState().activeTabId!, '改动')
}

beforeEach(() => {
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
  useStageStore.setState({ palette: null, focus: false, closingTabId: null, sheet: null })
  useLayoutStore.setState({ settingsOpen: false, exportOpen: false, newProjectOpen: false, importNovelOpen: false, chapterCreationOpen: false })
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  document.querySelectorAll('[data-test-layer]').forEach(node => node.remove())
  useLayoutStore.setState(layoutDefaults)
})

describe('命令键按平台区分', () => {
  it('Windows 只认 Ctrl，macOS 只认 ⌘；带 Alt、Shift 的组合不算', () => {
    const base = { key: 'k', code: 'KeyK', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }
    expect(isCommand({ ...base, ctrlKey: true }, 'k', false)).toBe(true)
    expect(isCommand({ ...base, metaKey: true }, 'k', false)).toBe(false)
    expect(isCommand({ ...base, metaKey: true }, 'k', true)).toBe(true)
    expect(isCommand({ ...base, ctrlKey: true }, 'k', true)).toBe(false)
    expect(isCommand({ ...base, ctrlKey: true, shiftKey: true }, 'k', false)).toBe(false)
    expect(isCommand({ ...base, ctrlKey: true, altKey: true }, 'k', false)).toBe(false)
  })

  it('拉丁布局看字母，非拉丁布局看物理键位', () => {
    const ctrlKey = { ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }
    expect(isCommand({ ...ctrlKey, key: 'л', code: 'KeyK' }, 'k', false)).toBe(true)
    expect(isCommand({ ...ctrlKey, key: 'k', code: 'KeyV' }, 'k', false)).toBe(true)
    expect(isCommand({ ...ctrlKey, key: 'v', code: 'KeyK' }, 'k', false)).toBe(false)
  })

  it('提示按平台写', () => {
    expect([commandLabel('k', false), commandLabel('k', true)]).toEqual(['Ctrl K', '⌘K'])
  })
})

describe('新外壳快捷键', () => {
  it('Ctrl W 在书房与对话框里也拦下，不落到应用菜单的「关闭」，也不关背后的标签', async () => {
    await mount(<Shortcuts library focus={false} />)
    expect(press(document.body, ctrl('w')).defaultPrevented).toBe(true)

    await act(async () => root!.render(<Shortcuts library={false} focus={false} />))
    openTab('config')
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.dataset.testLayer = ''
    const input = document.createElement('input')
    dialog.append(input)
    document.body.append(dialog)
    expect(press(input, ctrl('w')).defaultPrevented).toBe(true)
    expect(useEditorStore.getState().tabs).toHaveLength(1)
  })

  it('设置等旧弹窗或任何对话框开着时，Ctrl K、Ctrl P、Ctrl W 不在它下面开层', async () => {
    await mount(<Shortcuts library={false} focus={false} />)
    openTab('config', true)
    useLayoutStore.setState({ settingsOpen: true })
    press(document.body, ctrl('k'))
    press(document.body, ctrl('p'))
    press(document.body, ctrl('w'))
    expect(useStageStore.getState()).toMatchObject({ palette: null, closingTabId: null })

    useLayoutStore.setState({ settingsOpen: false })
    const alert = document.createElement('div')
    alert.setAttribute('role', 'alertdialog')
    alert.dataset.testLayer = ''
    document.body.append(alert)
    press(document.body, ctrl('k'))
    expect(useStageStore.getState().palette).toBeNull()
    alert.remove()

    const popover = document.createElement('div')
    popover.setAttribute('role', 'dialog')
    popover.className = 'pi-popover'
    popover.dataset.testLayer = ''
    document.body.append(popover)
    press(document.body, ctrl('k'))
    expect(useStageStore.getState().palette).toBe('commands')
  })

  it('搜索开着时 Ctrl K 关掉它，Ctrl W 不关背后的标签', async () => {
    await mount(<Shortcuts library={false} focus={false} />)
    openTab('config')
    useStageStore.setState({ palette: 'commands' })
    expect(press(document.body, ctrl('w')).defaultPrevented).toBe(true)
    expect(useEditorStore.getState().tabs).toHaveLength(1)
    press(document.body, ctrl('k'))
    expect(useStageStore.getState().palette).toBeNull()
  })

  it('macOS 上 Ctrl K、Ctrl P 留给编辑器，⌘K 打开搜索', async () => {
    await mount(<Shortcuts library={false} focus={false} mac />)
    expect(press(document.body, ctrl('k')).defaultPrevented).toBe(false)
    expect(press(document.body, ctrl('p')).defaultPrevented).toBe(false)
    expect(useStageStore.getState().palette).toBeNull()
    press(document.body, meta('k'))
    expect(useStageStore.getState().palette).toBe('commands')
  })

  it('输入法组字时快捷键与 Esc 都不接管', async () => {
    await mount(<Shortcuts library={false} focus />)
    useStageStore.setState({ focus: true })
    press(document.body, { ...ctrl('k'), isComposing: true })
    press(document.body, { key: 'Escape', keyCode: 229 })
    expect(useStageStore.getState()).toMatchObject({ palette: null, focus: true })
  })

  it('输入法组字时按 Ctrl W、⌘W 仍拦下关窗，但不关标签', async () => {
    await mount(<Shortcuts library={false} focus={false} />)
    openTab('config')
    expect(press(document.body, { ...ctrl('w'), isComposing: true }).defaultPrevented).toBe(true)
    expect(press(document.body, { ...ctrl('w'), key: 'Process', keyCode: 229 }).defaultPrevented).toBe(true)
    await act(async () => root!.render(<Shortcuts library={false} focus={false} mac />))
    expect(press(document.body, { ...meta('w'), isComposing: true }).defaultPrevented).toBe(true)
    expect(useStageStore.getState().closingTabId).toBeNull()
    expect(useEditorStore.getState().tabs).toHaveLength(1)
  })

  it('沉浸写作里，编辑器已处理的 Esc（关搜索框、收起补全）不退出沉浸；没人处理的 Esc 才退出', async () => {
    await mount(<Shortcuts library={false} focus />)
    useStageStore.setState({ focus: true })
    const editor = document.createElement('div')
    editor.dataset.testLayer = ''
    editor.addEventListener('keydown', event => { if (event.key === 'Escape') event.preventDefault() })
    document.body.append(editor)
    press(editor, { key: 'Escape' })
    expect(useStageStore.getState().focus).toBe(true)
    useLayoutStore.setState({ settingsOpen: true })
    press(document.body, { key: 'Escape' })
    expect(useStageStore.getState().focus).toBe(true)
    useLayoutStore.setState({ settingsOpen: false })
    press(document.body, { key: 'Escape' })
    expect(useStageStore.getState().focus).toBe(false)
  })

  it('Ctrl S 保存当前标签；模态层开着时不保存背后的标签', async () => {
    await mount(<Shortcuts library={false} focus={false} />)
    openTab('config', true)
    const save = vi.fn(async () => undefined)
    const unregister = registerEditorExitSaveHandler({ tabId: useEditorStore.getState().activeTabId!, type: 'config', projectKey: PROJECT, save })
    useLayoutStore.setState({ settingsOpen: true })
    press(document.body, ctrl('s'))
    expect(save).not.toHaveBeenCalled()
    useLayoutStore.setState({ settingsOpen: false })
    press(document.body, ctrl('s'))
    expect(save).toHaveBeenCalledOnce()
    unregister()
  })
})

describe('搜索与跳转面板', () => {
  it('输入法组字时的回车用来选词，不打开第一项；组字结束后回车才打开', async () => {
    const run = vi.fn()
    const items: PaletteItem[] = [{ id: 'chapter-1', group: 'chapter', chapter: 1, label: '第 1 章 · 旧港', run }]
    await mount(<StagePalette mode="commands" items={items} container={null} onClose={() => undefined} />)
    const input = document.querySelector<HTMLInputElement>('[role="combobox"]')!
    press(input, { key: 'Enter', isComposing: true })
    press(input, { key: 'Enter', keyCode: 229 })
    expect(run).not.toHaveBeenCalled()
    press(input, { key: 'Enter' })
    expect(run).toHaveBeenCalledOnce()
  })
})

describe('层级', () => {
  it('纸墨的对话框画在旧外壳最高的全屏层（z 10000 的错误提示）之上', async () => {
    await mount(<div className="pi-dialog" data-testid="ink-dialog" style={{ width: 200, height: 100 }} />)
    const legacy = document.createElement('div')
    legacy.dataset.testLayer = ''
    legacy.style.cssText = 'position: fixed; inset: 0; z-index: 10000;'
    document.body.append(legacy)
    const dialog = document.querySelector<HTMLElement>('[data-testid="ink-dialog"]')!
    const box = dialog.getBoundingClientRect()
    expect(dialog.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2))).toBe(true)
  })
})
