import { useLocaleStore } from '../../../stores/locale-store'
import type { ReactNode } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import type { ColorTheme } from '../../../shared/appearance-profile'
import '../../../styles/redesign/writer-shell.css'
import '../../../styles/redesign/v3-magazine.css'

export interface ShellV2Props {
  presentation?: 'classic' | 'writer'
  /** Visual-only V3 marker; the logical shell remains `writer`. */
  variant?: 'v3'
  theme: ColorTheme
  titleBar: ReactNode
  rail: ReactNode
  sidebar: ReactNode
  editor: ReactNode
  aiPanel: ReactNode
  bottom: ReactNode
  statusBar: ReactNode
  tabs?: ReactNode
  rightRail?: ReactNode
  sidebarOpen?: boolean
  aiPanelOpen?: boolean
  bottomOpen?: boolean
  immersive?: boolean
  /** Full-page shelf layout; keep all business slots mounted. */
  home?: boolean
}

/** Only presentation: business nodes and their state remain owned by the shared application. */
export default function ShellV2({ presentation = 'writer', variant, theme, titleBar, rail, sidebar, editor, aiPanel, bottom, statusBar,
  tabs, rightRail, sidebarOpen = true, aiPanelOpen = true, bottomOpen = true, immersive = false, home = false }: ShellV2Props) {
  const text = useLocaleStore(state => state.text)
  const writer = presentation === 'writer'
  const magazineV3 = writer && variant === 'v3'
  const magazineHome = magazineV3 && home
  const panelClass = writer ? 'writer-panel' : 'h-full min-h-0 overflow-auto'
  return <div
    className={writer ? `writer-shell${magazineV3 ? ' v3-magazine-shell' : ''}${magazineHome ? ' v3-magazine-home' : ''}` : 'flex h-full min-h-0 w-full flex-col overflow-hidden'}
    data-shell-presentation={presentation}
    data-shell-variant={magazineV3 ? 'v3' : undefined}
    data-writer-theme={writer ? theme : undefined}
    data-writer-immersive={writer ? immersive : undefined}
  >
    <div className={writer ? 'writer-title-host' : 'flex-none'}>
      {magazineV3 && <div className="v3-masthead-band" aria-hidden="true">{Array.from({ length: 7 }, (_, index) => <span key={index} />)}</div>}
      {titleBar}
    </div>
    <p className={writer ? 'writer-small-window' : 'hidden'} role="status">{text('窗口较窄，可横向滚动工作区，或收起侧栏与助手。', 'The window is narrow. Scroll the workspace or hide side panels.')}</p>
    <div className={writer ? 'writer-workspace-scroll' : 'flex-1 min-h-0 overflow-hidden'}>
      <div className={writer ? 'writer-workspace' : 'app-skin-main-region flex h-full min-w-0'}>
        <div className={writer ? 'writer-rail-host' : 'flex-none'}>{rail}</div>
        <Group orientation="vertical" className={writer ? 'writer-main' : 'h-full min-w-0 flex-1'}>
          <Panel id="writer-top" defaultSize={75} minSize={30}>
            <Group orientation="horizontal" className={writer ? 'writer-main' : 'h-full min-w-0 flex-1'}>
              <Panel id="writer-sidebar" hidden={!sidebarOpen || magazineHome} defaultSize={20} minSize={12}>
                <aside aria-label={text('作品资料', 'Project reference')} className={panelClass}>{sidebar}</aside>
              </Panel>
              {sidebarOpen && !magazineHome && <Separator className={writer ? 'writer-grip' : undefined} aria-label={text('调整资料栏宽度', 'Resize reference panel')} />}
              <Panel id="writer-editor" defaultSize={60} minSize={30}>
                <main aria-label={text('写作区', 'Writing area')} className={writer ? 'writer-editor' : 'flex h-full min-w-0 flex-col'}><div className={writer ? 'writer-tabs-host' : 'flex-none'}>{tabs}</div><div className={writer ? 'writer-editor-content' : 'flex-1 min-h-0 overflow-hidden'}>{editor}</div></main>
              </Panel>
              {aiPanelOpen && !magazineHome && <Separator className={writer ? 'writer-grip' : undefined} aria-label={text('调整助手宽度', 'Resize assistant panel')} />}
              <Panel id="writer-assistant" hidden={!aiPanelOpen || magazineHome} defaultSize={20} minSize={12}>
                <aside aria-label={text('写作助手', 'Writing assistant')} className={panelClass}>{aiPanel}</aside>
              </Panel>
            </Group>
          </Panel>
          {bottomOpen && !magazineHome && <Separator className={writer ? 'writer-grip writer-grip-horizontal' : undefined} aria-label={text('调整任务面板高度', 'Resize task panel')} />}
          <Panel id="writer-bottom" hidden={!bottomOpen || magazineHome} defaultSize={25} minSize={8}>
            <section aria-label={text('任务与日志', 'Tasks and logs')} className={panelClass}>{bottom}</section>
          </Panel>
        </Group>
        {rightRail && <div className={writer ? 'writer-rail-host' : 'flex-none'}>{rightRail}</div>}
      </div>
    </div>
    <footer className={writer ? 'writer-status-host' : 'flex-none'}>{statusBar}</footer>
  </div>
}
