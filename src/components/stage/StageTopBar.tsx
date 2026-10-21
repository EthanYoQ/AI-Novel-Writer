import { Check, ChevronDown, CircleDashed, Maximize2, Minimize2, Minus, Search, Settings, Square, X } from 'lucide-react'
import { ipc } from '../../services/ipc-client'
import { APP_BRAND } from '../../shared/brand'
import { useEditorStore } from '../../stores/editor-store'
import { countUnsavedEditorItemsForProject } from '../../stores/editor-unsaved'
import { useLocaleStore } from '../../stores/locale-store'
import { navigate } from '../../stores/navigation/navigation-intents'
import { useStageStore } from '../../stores/navigation/stage-store'
import { useProjectStore } from '../../stores/project-store'
import { Button } from '../ui/Button'
import { Menu, type MenuGroupSpec } from '../ui/Menu'
import RunCapsule from './RunCapsule'
import { commandLabel } from './shortcut-keys'


interface StageTopBarProps {
  /** 位置面包屑，最后一项为当前页。 */
  crumbs: readonly string[]
  library: boolean
  focus: boolean
  /** 沉浸写作时左侧显示的当前页：正文章节显示章号与章名，其余显示标签名。 */
  focusTitle: { chapter?: number; title: string }
  workMenu: readonly MenuGroupSpec[]
  onToggleFocus: () => void
}

function WindowControls() {
  const text = useLocaleStore(s => s.text)
  return (
    <div className="stage-window-controls">
      <button type="button" aria-label={text('最小化', 'Minimize')} onClick={() => void ipc.invoke('window:minimize')}>
        <Minus size={14} aria-hidden="true" />
      </button>
      <button type="button" aria-label={text('最大化', 'Maximize')} onClick={() => void ipc.invoke('window:toggle-maximize')}>
        <Square size={12} aria-hidden="true" />
      </button>
      <button type="button" className="stage-window-close" aria-label={text('关闭', 'Close')} onClick={() => void ipc.invoke('window:close')}>
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  )
}

export default function StageTopBar({ crumbs, library, focus, focusTitle, workMenu, onToggleFocus }: StageTopBarProps) {
  const text = useLocaleStore(s => s.text)
  const projectName = useProjectStore(s => s.currentProject?.name)
  const projectPath = useProjectStore(s => s.currentProject?.path)
  const dirty = useEditorStore(s => Boolean(projectPath) && countUnsavedEditorItemsForProject(s.tabs, s.draftLedgers, projectPath!) > 0)

  if (focus) {
    return (
      <header className="stage-topbar" data-focus="true">
        {focusTitle.chapter !== undefined && <span className="stage-focus-no">{focusTitle.chapter}</span>}
        <span className="stage-focus-title">{focusTitle.title}</span>
        <span className="stage-topbar-gap" />
        <Button variant="secondary" size="sm" aria-label={text('退出沉浸写作', 'Exit focus mode')} onClick={onToggleFocus}>
          <Minimize2 size={13} aria-hidden="true" />
          {text('退出沉浸', 'Exit focus')}
          <kbd>Esc</kbd>
        </Button>
        <WindowControls />
      </header>
    )
  }

  return (
    <header className="stage-topbar">
      <span className="stage-brand" aria-hidden="true" />
      {library || !projectName
        ? <span className="stage-work-title">{text(APP_BRAND.zhName, APP_BRAND.enName)}</span>
        : (
          <Menu
            label={text(`《${projectName}》作品菜单`, `“${projectName}” menu`)}
            trigger={{ className: 'stage-work-title', content: <><span className="stage-work-name" title={projectName}>{projectName}</span><ChevronDown size={14} aria-hidden="true" /></> }}
            groups={workMenu}
          />
        )}
      {crumbs.length > 0 && (
        <nav className="stage-crumbs" aria-label={text('位置', 'Location')}>
          {crumbs.map((crumb, index) => (
            <span key={`${index}-${crumb}`} className="stage-crumb" aria-current={index === crumbs.length - 1 ? 'page' : undefined}>{crumb}</span>
          ))}
        </nav>
      )}
      <div className="stage-topbar-center">
        <button type="button" className="stage-search" onClick={() => useStageStore.setState({ palette: 'commands' })}>
          <Search size={14} aria-hidden="true" />
          <span className="stage-search-hint">{library
            ? text('搜索作品，或打开文件夹', 'Search books, or open a folder')
            : text('搜索章节、角色，或跳转到任意阶段', 'Search chapters and characters, or jump to any stage')}</span>
          <kbd>{commandLabel('k')}</kbd>
        </button>
      </div>
      <RunCapsule />
      {library && (
        <Button variant="icon" size="sm" aria-label={text('设置', 'Settings')} onClick={() => navigate({ kind: 'settings', section: 'llm' })}>
          <Settings size={16} aria-hidden="true" />
        </Button>
      )}
      {!library && (
        <span className="stage-saved" data-dirty={dirty || undefined} role="status">
          {dirty ? <CircleDashed size={13} aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
          {dirty ? text('未保存', 'Unsaved') : text('已保存', 'Saved')}
        </span>
      )}
      {!library && (
        <Button variant="icon" size="sm" aria-label={text('进入沉浸写作', 'Enter focus mode')} onClick={onToggleFocus}>
          <Maximize2 size={15} aria-hidden="true" />
        </Button>
      )}
      <WindowControls />
    </header>
  )
}
