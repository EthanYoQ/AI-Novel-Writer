import type { ReactNode } from 'react'
import { useEffect } from 'react'
import { useLayoutStore } from '../../../stores/layout-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useUiVersionStore, isMagazine } from '../../../stores/ui-version-store'
import { sectionForRail } from '../../../shared/section-opener'
import { ErrorBoundary } from '../../ErrorBoundary'
import TitleBarV2 from './TitleBarV2'
import SpineNav from './SpineNav'
import StatusBarV2 from './StatusBarV2'
import GripHandle from './GripHandle'
import SectionSweep from './magazine/SectionSweep'

export interface ShellV2Props {
  sidebar: ReactNode
  editor: ReactNode
  aiPanel: ReactNode
  bottom: ReactNode
}

/**
 * 「墨纸书斋」外壳（v2）。
 *
 * demo 的恒定框架：顶栏 → [书脊 | 目录侧栏 | 中央纸面 | 助手] → 状态栏。
 * 这里只负责骨架与拖拽；内部一律嵌入产品既有的业务组件，
 * 业务状态仍由 layout-store 持有，换壳不迁移任何数据。
 */
export default function ShellV2({ sidebar, editor, aiPanel, bottom }: ShellV2Props) {
  const sidebarOpen = useLayoutStore((s) => s.sidebarOpen)
  const aiPanelOpen = useLayoutStore((s) => s.aiPanelOpen)
  const sidebarWidth = useLayoutStore((s) => s.sidebarWidth)
  const aiPanelWidth = useLayoutStore((s) => s.aiPanelWidth)
  const bottomPanelOpen = useLayoutStore((s) => s.bottomPanelOpen)
  const bottomPanelHeight = useLayoutStore((s) => s.bottomPanelHeight)
  const setSidebarWidth = useLayoutStore((s) => s.setSidebarWidth)
  const setAIPanelWidth = useLayoutStore((s) => s.setAIPanelWidth)
  const setBottomPanelHeight = useLayoutStore((s) => s.setBottomPanelHeight)
  const activeRailItem = useLayoutStore((s) => s.activeRailItem)
  const text = useLocaleStore((s) => s.text)
  const uiVersion = useUiVersionStore((s) => s.uiVersion)

  /**
   * 栏目背景（v3 专属）。
   *
   * 编辑区的底色、右下的巨号编号水印、左缘的色带，全部由这两个属性驱动 ——
   * CSS 用 `[data-sec='n']` 把栏目色映射到 `--mag-sec`，换栏目只换属性，
   * 不重建任何 DOM，所以是 200ms 的即时过渡而不是一场过场动画。
   *
   * 工具区（任务 / 日志 / 模型 / 设置）不是栏目，sectionForRail 返回 null，
   * 属性不挂出 —— 彩色永远只标记「创作的位置」。
   */
  const section = isMagazine(uiVersion) ? sectionForRail(activeRailItem) : null
  const editorAttrs = section
    ? { 'data-sec': String(section.mark), 'data-sec-no': section.no }
    : {}

  /**
   * 当前栏目色写到根节点 —— 让**四处同时指向同一栏**。
   *
   * 先生的原话（交接文档第八节第 3 项）：
   *   「让刊头彩带定位标 / 书脊选中块 / 编辑区顶带 / 侧栏选中行四处同步指向当前栏目色。」
   *
   * 编辑区的底色与水印走 `data-sec`（就近挂在 .editor 上）；而刊头与侧栏不在
   * 编辑区里，取不到那个局部变量 —— 所以这里再把同一份值写到 <html> 上：
   * `data-active-sec` 决定彩带定位标落在第几格，`--mag-active-sec` 给侧栏选中行
   * 与编辑区顶带取色。
   *
   * 离开 v3 或落到工具区（任务/日志/模型/设置）时**清掉**：彩色只标记创作的位置，
   * 工具区不该有栏目色，v2 更不该残留。
   */
  useEffect(() => {
    const root = document.documentElement
    if (!section) {
      root.style.removeProperty('--mag-active-sec')
      root.removeAttribute('data-active-sec')
      return
    }
    /* 变量给「取色」（侧栏选中行、编辑区顶带），属性给「定位」（刊头彩带定位标的中第几格）——
       两者都在 <html> 上，所以刊头与侧栏这些不在编辑区里的元素也取得到。 */
    root.style.setProperty('--mag-active-sec', `var(--mag-sec-${section.mark})`)
    root.setAttribute('data-active-sec', String(section.mark))
    return () => {
      root.style.removeProperty('--mag-active-sec')
      root.removeAttribute('data-active-sec')
    }
  }, [section])

  return (
    <div className="app v2-app">
      {/* 顶栏 / 书脊 / 状态栏是 v2 的常驻骨架，且 v2 是默认界面 ——
          它们不包 ErrorBoundary 的话，任一处在渲染阶段抛错都会卸载整棵根树
          （白屏、只能重启）。骨架崩溃时只降级该块，其余部分照常可用。 */}
      <ErrorBoundary fallbackLabel={text('顶栏渲染失败', 'Title bar failed to render')}>
        <TitleBarV2 />
      </ErrorBoundary>

      <div className="main">
        <div className="body3">
          <ErrorBoundary fallbackLabel={text('书脊导航渲染失败', 'Navigation spine failed to render')}>
            <SpineNav />
          </ErrorBoundary>

          {sidebarOpen && (
            <>
              <div className="sidebar-host" style={{ width: sidebarWidth }}>
                <ErrorBoundary fallbackLabel={text('侧边栏渲染失败', 'Sidebar failed to render')}>
                  {sidebar}
                </ErrorBoundary>
              </div>
              <GripHandle
                title={text('拖动调整侧栏宽度', 'Drag to resize the sidebar')}
                onDelta={(delta) => setSidebarWidth(sidebarWidth + delta)}
              />
            </>
          )}

          <section className="editor" {...editorAttrs}>
            <ErrorBoundary fallbackLabel={text('编辑区渲染失败', 'Editor failed to render')}>
              {editor}
            </ErrorBoundary>

            {/*
              v3 切栏目时的那一道 300ms 扫线。挂在编辑区这一层（不再挂进
              EditorArea 的两个 return 分支）：扫的是整块版面，与里面显示什么
              页面无关 —— 编辑区换页有几个分支，而这里只有一个挂载点。
            */}
            {section && <SectionSweep />}
          </section>

          {aiPanelOpen && (
            <>
              <GripHandle
                title={text('拖动调整助手宽度', 'Drag to resize the assistant panel')}
                onDelta={(delta) => setAIPanelWidth(aiPanelWidth - delta)}
              />
              <div className="aipanel-host" style={{ width: aiPanelWidth }}>
                <ErrorBoundary fallbackLabel={text('AI 面板渲染失败', 'AI panel failed to render')}>
                  {aiPanel}
                </ErrorBoundary>
              </div>
            </>
          )}
        </div>

        {bottomPanelOpen && (
          <>
            <GripHandle
              orientation="horizontal"
              className="v2-bottom-grip"
              title={text('拖动调整底部面板高度', 'Drag to resize the bottom panel')}
              onDelta={(delta) => setBottomPanelHeight(bottomPanelHeight - delta)}
            />
            <div className="v2-bottom" style={{ height: bottomPanelHeight }}>
              <ErrorBoundary fallbackLabel={text('底部面板渲染失败', 'Bottom panel failed to render')}>
                {bottom}
              </ErrorBoundary>
            </div>
          </>
        )}
      </div>

      <ErrorBoundary fallbackLabel={text('状态栏渲染失败', 'Status bar failed to render')}>
        <StatusBarV2 />
      </ErrorBoundary>
    </div>
  )
}
