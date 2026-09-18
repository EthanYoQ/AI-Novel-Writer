import { useLocaleStore } from '../../../stores/locale-store'
import type { ReactNode } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import type { ColorTheme } from '../../../shared/appearance-profile'
import '../../../styles/redesign/writer-shell.css'

export interface ShellV2Props {
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
}

/** Only presentation: business nodes and their state remain owned by the shared application. */
export default function ShellV2({ theme, titleBar, rail, sidebar, editor, aiPanel, bottom, statusBar,
  tabs, rightRail, sidebarOpen = true, aiPanelOpen = true, bottomOpen = true }: ShellV2Props) {
  const text = useLocaleStore(state => state.text)
  return <div className="writer-shell" data-writer-theme={theme}>
    <div className="writer-title-host">{titleBar}</div>
    <p className="writer-small-window" role="status">{text('窗口较窄，可横向滚动工作区，或收起侧栏与助手。', 'The window is narrow. Scroll the workspace or hide side panels.')}</p>
    <div className="writer-workspace-scroll">
      <div className="writer-workspace">
        <div className="writer-rail-host">{rail}</div>
        <Group orientation="vertical" className="writer-main">
          <Panel id="writer-top" defaultSize={75} minSize={30}>
            <Group orientation="horizontal" className="writer-main">
              <Panel id="writer-sidebar" hidden={!sidebarOpen} defaultSize={20} minSize={12}>
                <aside aria-label={text('作品资料', 'Project reference')} className="writer-panel">{sidebar}</aside>
              </Panel>
              {sidebarOpen && <Separator className="writer-grip" aria-label={text('调整资料栏宽度', 'Resize reference panel')} />}
              <Panel id="writer-editor" defaultSize={60} minSize={30}>
                <main aria-label={text('写作区', 'Writing area')} className="writer-editor"><div className="writer-tabs-host">{tabs}</div><div className="writer-editor-content">{editor}</div></main>
              </Panel>
              {aiPanelOpen && <Separator className="writer-grip" aria-label={text('调整助手宽度', 'Resize assistant panel')} />}
              <Panel id="writer-assistant" hidden={!aiPanelOpen} defaultSize={20} minSize={12}>
                <aside aria-label={text('写作助手', 'Writing assistant')} className="writer-panel">{aiPanel}</aside>
              </Panel>
            </Group>
          </Panel>
          {bottomOpen && <Separator className="writer-grip writer-grip-horizontal" aria-label={text('调整任务面板高度', 'Resize task panel')} />}
          <Panel id="writer-bottom" hidden={!bottomOpen} defaultSize={25} minSize={8}>
            <section aria-label={text('任务与日志', 'Tasks and logs')} className="writer-panel">{bottom}</section>
          </Panel>
        </Group>
        {rightRail && <div className="writer-rail-host">{rightRail}</div>}
      </div>
    </div>
    <footer className="writer-status-host">{statusBar}</footer>
  </div>
}
