import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import ShellV2 from '../ShellV2'
import WelcomePageV2 from '../../../pages/v2/WelcomePageV2'
import type { ColorTheme } from '../../../../shared/appearance-profile'
import { PROJECT_OVERVIEW_STAGE_IDS } from '../../../../shared/project-overview'

let host: HTMLDivElement
let root: Root
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
beforeEach(async () => {
  await page.viewport(1280, 900)
  host = document.createElement('div'); host.style.height = '860px'; document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })
function shell(theme: ColorTheme, editor: ReactNode, action = vi.fn(), sidebarOpen = true, slots: {
  sidebar?: ReactNode
  aiPanel?: ReactNode
  bottom?: ReactNode
  aiPanelOpen?: boolean
  bottomOpen?: boolean
} = {}) {
  return <ShellV2 theme={theme} sidebarOpen={sidebarOpen} aiPanelOpen={slots.aiPanelOpen} bottomOpen={slots.bottomOpen} titleBar={<span>雨夜来信 · 第一章</span>}
    rail={<button onClick={action}>书架</button>}
    sidebar={slots.sidebar ?? <p>{'作品资料'}</p>} editor={editor} tabs={<button>{'第一章 · 未保存'}</button>}
    aiPanel={slots.aiPanel ?? <textarea aria-label={'助手输入'} defaultValue={'请保留这段问题'} />}
    bottom={slots.bottom ?? <p>{'任务尚未开始'}</p>} statusBar={<span>{'本地写作 · 尚未调用模型'}</span>} />
}
function welcome(state: 'ready' | 'loading' | 'empty' | 'unavailable') {
  return <WelcomePageV2 overview={{ state, name: state === 'ready' ? '雨夜来信' : undefined, totalWords: 1234, characters: null, finalizedChapters: 2, excerpt: '雨停以后，她在门边发现了一封没有署名的信。', stages: PROJECT_OVERVIEW_STAGE_IDS.map((id, index) => ({ id, status: index < 2 ? 'completed' as const : 'not-started' as const })) }} recentProjects={[]} onNewProject={vi.fn()} onOpenProject={vi.fn()} onImportNovel={vi.fn()} backup={<p>{'项目存档尚未配置'}</p>} />
}
it.each(['light', 'paper', 'galaxy', 'dark'] as const)('四颜色 %s：真实props与外壳隔离', async theme => {
  const classic = document.createElement('button'); classic.textContent = '经典外壳'; document.body.append(classic)
  const before = getComputedStyle(classic).backgroundColor
  host.style.setProperty('--font-sans', 'monospace')
  try {
    await act(async () => root.render(shell(theme, welcome('ready'))))
    expect(host.textContent).toContain('1,234'); expect(host.textContent).toContain('待读取')
    expect(getComputedStyle(classic).backgroundColor).toBe(before)
    expect(getComputedStyle(host.querySelector('.writer-shell')!).fontFamily).toBe('monospace')
    expect(getComputedStyle(host.querySelector('.writer-tabs-host button')!).fontFamily).toBe('monospace')
    await page.screenshot({ path: `../../../../../.runtime/.cache/novel-quality-modernization/f02-${theme}.png` })
  } finally { classic.remove() }
})
it.each(['loading', 'empty', 'unavailable'] as const)('未知数据 %s 不展示伪统计或旧尾句', async state => {
  await act(async () => root.render(shell('paper', welcome(state))))
  expect(host.textContent).not.toContain('1,234'); expect(host.textContent).not.toContain('没有署名的信')
  expect(host.querySelector('progress')).toBeNull()
})
it('隐藏面板不卸载共享业务节点', async () => {
  const action = vi.fn()
  const slots = {
    sidebar: <input aria-label={'作品资料输入'} defaultValue={'保留资料'} />,
    aiPanel: <textarea aria-label={'助手输入'} defaultValue={'请保留这段问题'} />,
    bottom: <input aria-label={'任务输入'} defaultValue={'保留任务'} />,
  }
  await act(async () => root.render(shell('paper', <textarea aria-label={'作者正文'} defaultValue={'尚未保存的原稿'} />, action, true, slots)))
  const nav = host.querySelector<HTMLButtonElement>('.writer-rail-host button')!; nav.focus()
  await act(async () => userEvent.keyboard('{Enter}')); expect(action).toHaveBeenCalledOnce()
  const body = host.querySelector<HTMLTextAreaElement>('[aria-label="作者正文"]')!
  const sidebar = host.querySelector<HTMLInputElement>('[aria-label="作品资料输入"]')!
  const assistant = host.querySelector<HTMLTextAreaElement>('[aria-label="助手输入"]')!
  const bottom = host.querySelector<HTMLInputElement>('[aria-label="任务输入"]')!
  sidebar.value = '作者资料草稿'
  assistant.setSelectionRange(2, 5)
  bottom.value = '正在运行的任务'
  await act(async () => root.render(shell('paper', <textarea aria-label={'作者正文'} defaultValue={'尚未保存的原稿'} />, action, false, {
    ...slots,
    aiPanelOpen: false,
    bottomOpen: false,
  })))
  expect(host.querySelector('[aria-label="作者正文"]')).toBe(body); expect(body.value).toBe('尚未保存的原稿')
  expect(host.querySelector('[aria-label="作品资料输入"]')).toBe(sidebar); expect(sidebar.value).toBe('作者资料草稿')
  expect(host.querySelector('[aria-label="助手输入"]')).toBe(assistant); expect(assistant.selectionStart).toBe(2)
  expect(host.querySelector('[aria-label="任务输入"]')).toBe(bottom); expect(bottom.value).toBe('正在运行的任务')
})
it('窄窗口给出可读提示并保留横向工作区', async () => {
  await page.viewport(640, 800)
  await act(async () => root.render(shell('paper', welcome('empty'))))
  expect(getComputedStyle(host.querySelector('.writer-small-window')!).display).not.toBe('none')
  expect(host.querySelector('.writer-workspace')!.getBoundingClientRect().width).toBeGreaterThanOrEqual(760)
  await page.screenshot({ path: '../../../../../.runtime/.cache/novel-quality-modernization/f02-narrow.png' })
})
