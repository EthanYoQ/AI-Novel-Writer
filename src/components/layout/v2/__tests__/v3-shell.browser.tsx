import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import ShellV2 from '../ShellV2'
import TitleBarV2 from '../TitleBarV2'
import LeftToolWindowBar from '../../LeftToolWindowBar'
import WelcomePageV2 from '../../../pages/v2/WelcomePageV2'
import { vi } from 'vitest'
import { useLayoutStore } from '../../../../stores/layout-store'
import { useProjectStore } from '../../../../stores/project-store'
import { useAppearanceStore } from '../../../../stores/appearance-bootstrap'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(async () => {
  await page.viewport(1280, 900)
  host = document.createElement('div')
  host.style.height = '860px'
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

it('V3 explicit variant keeps writer shell semantics and shared editor owner', async () => {
  const editor = <textarea aria-label="共享正文" defaultValue="未保存正文" />

  await act(async () => root.render(
    <ShellV2
      presentation="writer"
      variant="v3"
      theme="paper"
      titleBar={<span>书名</span>}
      rail={<span>书架</span>}
      sidebar={<span>目录</span>}
      editor={editor}
      tabs={<span>第一章</span>}
      aiPanel={<span>助手</span>}
      bottom={<span>任务</span>}
      statusBar={<span>状态</span>}
    />,
  ))

  const shell = host.querySelector<HTMLElement>('[data-shell-presentation="writer"]')
  const editorNode = host.querySelector<HTMLTextAreaElement>('[aria-label="共享正文"]')
  expect(shell?.dataset.shellVariant).toBe('v3')
  expect(shell?.classList.contains('v3-magazine-shell')).toBe(true)
  expect(getComputedStyle(shell!).getPropertyValue('--v3-font-display').trim()).toContain('Noto Serif SC')
  expect(getComputedStyle(shell!).fontFamily).toContain('Noto Sans SC')
  expect(editorNode).toBeTruthy()
  await page.screenshot({
    path: '../../../../../.runtime/.cache/novel-quality-modernization/v3-thin-slice-shell.png',
  })

  editorNode!.value = '作者刚输入的正文'
  await act(async () => root.render(
    <ShellV2
      presentation="writer"
      variant="v3"
      theme="paper"
      titleBar={<span>书名</span>}
      rail={<span>书架</span>}
      sidebar={<span>目录</span>}
      editor={editor}
      tabs={<span>第一章</span>}
      aiPanel={<span>助手</span>}
      bottom={<span>任务</span>}
      statusBar={<span>状态</span>}
    />,
  ))

  expect(host.querySelector('[aria-label="共享正文"]')).toBe(editorNode)
  expect(editorNode!.value).toBe('作者刚输入的正文')
})

it('Classic presentation does not opt into the V3 variant', async () => {
  await act(async () => root.render(
    <ShellV2
      presentation="classic"
      variant="v3"
      theme="paper"
      titleBar={<span>书名</span>}
      rail={<span>书架</span>}
      sidebar={<span>目录</span>}
      editor={<span>正文</span>}
      aiPanel={<span>助手</span>}
      bottom={<span>任务</span>}
      statusBar={<span>状态</span>}
    />,
  ))

  const shell = host.querySelector<HTMLElement>('[data-shell-presentation="classic"]')
  expect(shell?.dataset.shellVariant).toBeUndefined()
  expect(shell?.classList.contains('v3-magazine-shell')).toBe(false)
})

it('V3 dark and galaxy themes keep the welcome spread and left rail readable', async () => {
  await page.viewport(1440, 900)
  host.style.height = '900px'
  for (const theme of ['dark', 'galaxy'] as const) {
    await act(async () => root.render(
      <ShellV2
        presentation="writer"
        variant="v3"
        theme={theme}
        titleBar={<span>刊头</span>}
        rail={<div className="writer-left-rail"><button className="left-nav-button" type="button">章节</button></div>}
        sidebar={<span>目录</span>}
        editor={<WelcomePageV2 overview={{ state: 'empty' }} recentProjects={[]} onNewProject={() => {}} onOpenProject={() => {}} onImportNovel={() => {}} />}
        aiPanel={<span>助手</span>}
        bottom={<span>任务</span>}
        statusBar={<span>页脚</span>}
      />,
    ))

    const shell = host.querySelector<HTMLElement>('.v3-magazine-shell')!
    const welcome = host.querySelector<HTMLElement>('.writer-welcome')!
    const action = host.querySelector<HTMLButtonElement>('.writer-welcome-actions button')!
    const rail = host.querySelector<HTMLElement>('.writer-left-rail')!
    const nav = host.querySelector<HTMLButtonElement>('.writer-left-rail .left-nav-button')!

    expect(getComputedStyle(shell).backgroundImage).not.toContain('rgb(255, 255, 255)')
    expect(getComputedStyle(welcome).backgroundImage).not.toContain('rgb(255, 255, 255)')
    expect(getComputedStyle(action).backgroundColor).not.toBe('rgb(255, 255, 255)')
    expect(getComputedStyle(rail).backgroundColor).not.toBe('rgb(255, 255, 255)')
    expect(getComputedStyle(action).color).not.toBe(getComputedStyle(action).backgroundColor)
    expect(getComputedStyle(nav).color).not.toBe(getComputedStyle(rail).backgroundColor)

    await page.screenshot({
      path: `../../../../../.runtime/.cache/novel-quality-modernization/v3-${theme}-welcome-browser-1440x900-css.png`,
    })
  }
})

it('V3 home gives the shelf the full page without unmounting shared slots', async () => {
  const editor = <textarea aria-label="共享正文" defaultValue="作者原稿" />
  const assistant = <input aria-label="助手输入" defaultValue="待发送内容" />
  const props = { presentation: 'writer' as const, variant: 'v3' as const, theme: 'light' as const,
    titleBar: <span>刊头</span>, rail: <span>书脊</span>, sidebar: <span>目录</span>,
    editor, aiPanel: assistant, bottom: <span>任务</span>, statusBar: <span>页脚</span>, rightRail: <span>工具</span> }
  await act(async () => root.render(<ShellV2 {...props} home={false} />))
  const body = host.querySelector<HTMLTextAreaElement>('[aria-label="共享正文"]')!
  const ai = host.querySelector<HTMLInputElement>('[aria-label="助手输入"]')!
  body.value = '仍未保存'
  ai.value = '仍未发送'
  await act(async () => root.render(<ShellV2 {...props} home />))
  const shell = host.querySelector<HTMLElement>('.v3-magazine-shell')!
  expect(shell.classList.contains('v3-magazine-home')).toBe(true)
  expect(host.querySelector<HTMLElement>('#writer-sidebar')?.hidden).toBe(true)
  expect(host.querySelector<HTMLElement>('#writer-assistant')?.hidden).toBe(true)
  expect(host.querySelector<HTMLElement>('#writer-bottom')?.hidden).toBe(true)
  expect(getComputedStyle(host.querySelector('.writer-workspace > .writer-rail-host:last-child')!).display).toBe('none')
  expect(host.querySelector('[aria-label="共享正文"]')).toBe(body)
  expect(host.querySelector('[aria-label="助手输入"]')).toBe(ai)
  await act(async () => root.render(<ShellV2 {...props} home={false} />))
  expect(host.querySelector('[aria-label="共享正文"]')).toBe(body)
  expect(body.value).toBe('仍未保存')
  expect(host.querySelector('[aria-label="助手输入"]')).toBe(ai)
  expect(ai.value).toBe('仍未发送')
})

it('V3 magazine masthead, real App rail and shelf retain navigation callbacks', async () => {
  await page.viewport(1440, 900)
  host.style.height = '900px'
  document.body.style.margin = '0'
  const preview = vi.fn()
  const open = vi.fn()
  const home = vi.fn()
  useLayoutStore.getState().setSidebarView('home')
  await act(async () => root.render(<ShellV2 presentation="writer" variant="v3" theme="paper"
    titleBar={<TitleBarV2 projectName="雨夜来信" documentName="第一章" status="已保存" actions={[]} onHome={home} />}
    rail={<LeftToolWindowBar />}
    sidebar={<div>作品资料</div>}
    editor={<WelcomePageV2 overview={{ state: 'ready', name: '雨夜来信', totalWords: 1200, finalizedChapters: 1, characters: 2 }} recentProjects={[{ id: 'novel-1', name: '雨夜来信', onPreview: preview, onOpen: open }]} onNewProject={vi.fn()} onOpenProject={vi.fn()} onImportNovel={vi.fn()} />}
    aiPanel={<div>助手</div>} bottom={<div>任务</div>} statusBar={<div>本地写作</div>} />))

  expect(host.querySelector('.v3-masthead-band')).toBeTruthy()
  expect(host.querySelectorAll('.v3-masthead-band span')).toHaveLength(7)
  expect(host.querySelectorAll('.v3-magazine-shell .writer-left-rail > div:first-child .left-nav-button')).toHaveLength(7)
  expect(host.querySelector('.writer-left-rail .left-nav-button.is-active')?.textContent).toContain('首页')
  expect(host.querySelector('.writer-shelf .v3-bookcase')).toBeTruthy()
  expect(host.querySelector('.writer-overview .v3-overview-kicker')).toBeTruthy()
  await page.screenshot({ path: '../../../../../.runtime/.cache/novel-quality-modernization/v3-shelf-thin-slice-browser.png' })
  host.querySelector<HTMLButtonElement>('[aria-label="预览《雨夜来信》"]')!.click()
  host.querySelector<HTMLButtonElement>('[aria-label="打开《雨夜来信》"]')!.click()
  expect(preview).toHaveBeenCalledOnce()
  expect(open).toHaveBeenCalledOnce()
  await act(async () => host.querySelector<HTMLButtonElement>('.writer-left-rail button[title="设置"]')!.click())
  expect(useLayoutStore.getState().settingsOpen).toBe(true)
  await act(async () => useLayoutStore.getState().closeSettings())
})

it('V3 active project section marks the editor canvas without replacing the editor', async () => {
  useLayoutStore.getState().setSidebarView('project')
  const editor = <textarea aria-label="合成正文" defaultValue="雨停以后，她在门边发现了一封没有署名的信。" />
  await act(async () => root.render(<ShellV2 presentation="writer" variant="v3" theme="light"
    titleBar={<span>刊头</span>} rail={<LeftToolWindowBar />} sidebar={<span>目录</span>}
    editor={editor} aiPanel={<span>助手</span>} bottom={<span>任务</span>} statusBar={<span>页脚</span>} />))
  const paper = host.querySelector<HTMLElement>('.writer-editor')!
  const body = host.querySelector<HTMLTextAreaElement>('[aria-label="合成正文"]')!
  expect(getComputedStyle(paper, '::after').content).toBe('"02"')
  expect(getComputedStyle(paper, '::before').width).toBe('4px')
  await act(async () => host.querySelector<HTMLButtonElement>('.writer-left-rail button[title="角色"]')!.click())
  expect(getComputedStyle(paper, '::after').content).toBe('"03"')
  expect(host.querySelector('[aria-label="合成正文"]')).toBe(body)
})

/**
 * The donor reference is a 1152x720 capture; the current packaged reference
 * is 1440x900. Keep this browser capture explicit and directional until both
 * sides can be recaptured with the same viewport, zoom and font environment.
 */
it('renders the V3 empty shelf at the current 1440x900 browser viewport', async () => {
  await page.viewport(1440, 900)
  host.style.height = '900px'
  document.body.style.margin = '0'
  useProjectStore.setState({ currentProject: null })
  useLayoutStore.setState({ activeRailItem: 'project', sidebarView: 'project' })
  const priorShell = useAppearanceStore.getState().resolvedShell
  useAppearanceStore.setState({ resolvedShell: 'writer' })
  await act(async () => root.render(<ShellV2 presentation="writer" variant="v3" theme="light" home
    titleBar={<TitleBarV2 status="已保存" actions={[]} onHome={() => {}} />}
    rail={<LeftToolWindowBar />} sidebar={<span>目录</span>}
    editor={<WelcomePageV2 overview={{ state: 'empty' }} recentProjects={[]} onNewProject={() => {}} onOpenProject={() => {}} onImportNovel={() => {}} />}
    aiPanel={<span>助手</span>} bottom={<span>任务</span>} statusBar={<span>本地写作</span>} />))
  expect(host.querySelector('.writer-overview [role="status"]')?.textContent).toContain('尚未打开作品')
  expect(host.querySelector<HTMLButtonElement>('.writer-left-rail button[title="欢迎页"]')?.classList.contains('is-active')).toBe(true)
  expect(host.querySelector<HTMLButtonElement>('.writer-left-rail button[title="项目"]')?.classList.contains('is-active')).toBe(false)
  await page.screenshot({ path: '../../../../../.runtime/.cache/novel-quality-modernization/v3-current-shelf-empty-browser-1440x900-css.png' })
  await act(async () => useAppearanceStore.setState({ resolvedShell: 'classic' }))
  expect(host.querySelector<HTMLButtonElement>('.writer-left-rail button[title="欢迎页"]')?.classList.contains('is-active')).toBe(false)
  expect(host.querySelector<HTMLButtonElement>('.writer-left-rail button[title="项目"]')?.classList.contains('is-active')).toBe(true)
  await act(async () => useAppearanceStore.setState({ resolvedShell: priorShell }))
})
