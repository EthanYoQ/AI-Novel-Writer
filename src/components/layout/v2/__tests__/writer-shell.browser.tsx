import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { BookOpen, Settings } from 'lucide-react'
import ShellV2 from '../ShellV2'
import TitleBarV2 from '../TitleBarV2'
import SpineNav from '../SpineNav'
import WriterPortal from '../WriterPortal'
import WelcomePageV2 from '../../../pages/v2/WelcomePageV2'
import type { ColorTheme } from '../../../../shared/appearance-profile'
import { PROJECT_OVERVIEW_STAGE_IDS } from '../../../../shared/project-overview'

let host: HTMLDivElement
let portal: HTMLDivElement
let root: Root
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
beforeEach(async () => {
  await page.viewport(1280, 900)
  host = document.createElement('div'); host.style.height = '860px'; document.body.append(host)
  portal = document.createElement('div'); document.body.append(portal)
  root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); portal.remove() })
function shell(theme: ColorTheme, editor: ReactNode, action = vi.fn(), sidebarOpen = true, slots: {
  sidebar?: ReactNode
  aiPanel?: ReactNode
  bottom?: ReactNode
  aiPanelOpen?: boolean
  bottomOpen?: boolean
  presentation?: 'classic' | 'writer'
} = {}) {
  return <ShellV2 presentation={slots.presentation} theme={theme} sidebarOpen={sidebarOpen} aiPanelOpen={slots.aiPanelOpen} bottomOpen={slots.bottomOpen} titleBar={<TitleBarV2 projectName={'雨夜来信'} documentName={'第一章'} status={'有未保存修改'} onHome={action}
    actions={[{ id: 'new', label: '新建作品', onAction: action }, { id: 'backup', label: '项目备份', unavailableReason: '等待存档服务接入' }]} />}
    rail={<SpineNav activeId="home" items={[{ id: 'home', label: '书架', icon: BookOpen, onAction: action }, { id: 'settings', label: '设置', icon: Settings, onAction: action }]} />}
    sidebar={slots.sidebar ?? <p>{'作品资料'}</p>} editor={editor} tabs={<button>{'第一章 · 未保存'}</button>}
    aiPanel={slots.aiPanel ?? <textarea aria-label={'助手输入'} defaultValue={'请保留这段问题'} />}
    bottom={slots.bottom ?? <p>{'任务尚未开始'}</p>} statusBar={<span>{'本地写作 · 尚未调用模型'}</span>} />
}
function welcome(state: 'ready' | 'loading' | 'empty' | 'unavailable') {
  return <WelcomePageV2 overview={{ state, name: state === 'ready' ? '雨夜来信' : undefined, totalWords: 1234, characters: null, finalizedChapters: 2, excerpt: '雨停以后，她在门边发现了一封没有署名的信。', stages: PROJECT_OVERVIEW_STAGE_IDS.map((id, index) => ({ id, status: index < 2 ? 'completed' as const : 'not-started' as const })) }} recentProjects={[]} onNewProject={vi.fn()} onOpenProject={vi.fn()} onImportNovel={vi.fn()} backup={<p>{'项目存档尚未配置'}</p>} />
}
it.each(['light', 'paper', 'galaxy', 'dark'] as const)('四颜色 %s：真实props、portal与经典隔离', async theme => {
  const classic = document.createElement('button'); classic.textContent = '经典外壳'; document.body.append(classic)
  const before = getComputedStyle(classic).backgroundColor
  host.style.setProperty('--font-sans', 'monospace')
  portal.style.setProperty('--font-sans', 'monospace')
  try {
    await act(async () => root.render(<>{shell(theme, welcome('ready'))}<WriterPortal theme={theme} container={portal}><div className="writer-dialog" style={{ position: 'fixed', bottom: 24, right: 24, width: 280 }} role="dialog" aria-label={'保存确认'}><p>{'保留当前修改后再切换作品。'}</p><button>{'取消切换'}</button></div></WriterPortal></>))
    expect(host.textContent).toContain('1,234'); expect(host.textContent).toContain('待读取')
    expect(getComputedStyle(portal.querySelector('.writer-dialog')!).backgroundColor).toBe(getComputedStyle(host.querySelector('.writer-shell')!).backgroundColor)
    expect(getComputedStyle(classic).backgroundColor).toBe(before)
    expect(getComputedStyle(host.querySelector('.writer-shell')!).fontFamily).toBe('monospace')
    expect(getComputedStyle(portal.querySelector('.writer-portal')!).fontFamily).toBe('monospace')
    for (const button of [host.querySelector('.writer-tabs-host button')!, portal.querySelector('button')!]) {
      const style = getComputedStyle(button)
      expect(style.fontFamily).toBe('monospace')
      expect(contrast(style.color, style.backgroundColor)).toBeGreaterThanOrEqual(4.5)
      expect(style.borderStyle).toBe('solid')
    }
    expect(host.querySelector('.writer-spine [aria-current="page"]')?.textContent).toContain('书架')
    await page.screenshot({ path: `../../../../../.runtime/.cache/novel-quality-modernization/f02-${theme}.png` })
  } finally { classic.remove() }
})
it.each(['loading', 'empty', 'unavailable'] as const)('未知数据 %s 不展示伪统计或旧尾句', async state => {
  await act(async () => root.render(shell('paper', welcome(state))))
  expect(host.textContent).not.toContain('1,234'); expect(host.textContent).not.toContain('没有署名的信')
  expect(host.querySelector('progress')).toBeNull()
})
it('键盘可操作导航，隐藏面板不卸载共享业务节点，备份未接不冒充成功', async () => {
  const action = vi.fn()
  const slots = {
    sidebar: <input aria-label={'作品资料输入'} defaultValue={'保留资料'} />,
    aiPanel: <textarea aria-label={'助手输入'} defaultValue={'请保留这段问题'} />,
    bottom: <input aria-label={'任务输入'} defaultValue={'保留任务'} />,
  }
  await act(async () => root.render(shell('paper', <textarea aria-label={'作者正文'} defaultValue={'尚未保存的原稿'} />, action, true, slots)))
  const nav = host.querySelector<HTMLButtonElement>('.writer-spine button')!; nav.focus()
  await act(async () => userEvent.keyboard('{Enter}')); expect(action).toHaveBeenCalledOnce()
  expect(document.activeElement).toBe(nav)
  expect(getComputedStyle(nav).outlineStyle).not.toBe('none')
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
  const backup = host.querySelector<HTMLButtonElement>('.writer-file-actions button:disabled')!
  expect(backup.textContent).toContain('等待存档服务接入')
})
it('窄窗口给出可读提示并保留横向工作区', async () => {
  await page.viewport(640, 800)
  await act(async () => root.render(shell('paper', welcome('empty'))))
  expect(getComputedStyle(host.querySelector('.writer-small-window')!).display).not.toBe('none')
  expect(host.querySelector('.writer-workspace')!.getBoundingClientRect().width).toBeGreaterThanOrEqual(760)
  await page.screenshot({ path: '../../../../../.runtime/.cache/novel-quality-modernization/f02-narrow.png' })
})
it('切换 Classic 与 Writer presentation 不重建业务 slot', async () => {
  const editor = <textarea aria-label={'共享正文'} defaultValue={'未保存正文'} />
  const aiPanel = <textarea aria-label={'共享助手'} defaultValue={'未发送问题'} />
  await act(async () => root.render(shell('paper', editor, vi.fn(), true, { aiPanel, presentation: 'writer' })))
  const editorNode = host.querySelector<HTMLTextAreaElement>('[aria-label="共享正文"]')!
  const assistantNode = host.querySelector<HTMLTextAreaElement>('[aria-label="共享助手"]')!
  editorNode.value = '作者刚输入的正文'
  assistantNode.value = '作者刚输入的问题'

  await act(async () => root.render(shell('paper', editor, vi.fn(), true, { aiPanel, presentation: 'classic' })))

  expect(host.querySelector('[aria-label="共享正文"]')).toBe(editorNode)
  expect(host.querySelector('[aria-label="共享助手"]')).toBe(assistantNode)
  expect(editorNode.value).toBe('作者刚输入的正文')
  expect(assistantNode.value).toBe('作者刚输入的问题')
  const classic = host.querySelector<HTMLElement>('[data-shell-presentation="classic"]')!
  expect(classic.classList.contains('writer-shell')).toBe(false)
  expect(classic.hasAttribute('data-writer-theme')).toBe(false)
  expect(classic.querySelector('.app-skin-main-region')).toBeTruthy()
  expect(host.querySelector('.writer-workspace')).toBeNull()
})

// WCAG relative luminance from the browser's actual sRGB computed colors.
function contrast(foreground: string, background: string): number {
  const luminance = (color: string) => {
    const rgb = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(value => {
      const channel = value / 255
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    })
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
  }
  const a = luminance(foreground); const b = luminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}
