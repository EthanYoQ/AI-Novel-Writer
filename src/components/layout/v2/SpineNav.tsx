import {
  BookMarked,
  BookOpen,
  Cpu,
  GitBranch,
  Globe2,
  List,
  ListChecks,
  ListTree,
  ScrollText,
  Settings,
  Users,
  type LucideIcon,
} from 'lucide-react'
import { useLayoutStore, type BottomTab } from '../../../stores/layout-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import { goRail, type RailKey } from './rail-routing'
import { useLocaleStore } from '../../../stores/locale-store'

/**
 * 书脊导航（Spine）。
 *
 * demo 的书脊六项对应六个栏目，点栏目走 navGo：把中央纸面的焦点带到该栏目的落点页，
 * 页面以标签承载，谁要看就激活谁的标签。产品在六项之外另有「蓝图」独立入口，行为一致。
 *
 * 任务 / 日志 / 模型是产品的底层面板，不占中央纸面，保持原样。
 */
interface SpineItem {
  key: RailKey | BottomTab
  icon: LucideIcon
  zh: string
  en: string
  titleZh: string
  titleEn: string
  onClick: () => void
}

export default function SpineNav() {
  const activeRailItem = useLayoutStore((s) => s.activeRailItem)
  const setBottomTab = useLayoutStore((s) => s.setBottomTab)
  const openSettings = useLayoutStore((s) => s.openSettings)
  const settingsOpen = useLayoutStore((s) => s.settingsOpen)
  const currentRun = useWorkflowStore((s) => s.currentRun)
  const text = useLocaleStore((s) => s.text)

  const mainItems: SpineItem[] = [
    {
      key: 'home',
      icon: BookMarked,
      zh: '书架',
      en: 'Shelf',
      titleZh: '书架与最近项目',
      titleEn: 'Shelf and recent projects',
      onClick: () => goRail('home'),
    },
    {
      key: 'project',
      icon: List,
      zh: '目录',
      en: 'Contents',
      titleZh: '作品目录与稿件',
      titleEn: 'Manuscript contents',
      onClick: () => goRail('project'),
    },
    {
      key: 'characters',
      icon: Users,
      zh: '人物',
      en: 'Cast',
      titleZh: '人物档案',
      titleEn: 'Character profiles',
      onClick: () => goRail('characters'),
    },
    {
      key: 'world',
      icon: Globe2,
      zh: '设定',
      en: 'World',
      titleZh: '设定集',
      titleEn: 'World building',
      onClick: () => goRail('world'),
    },
    {
      key: 'plot-tree',
      icon: GitBranch,
      zh: '伏笔',
      en: 'Threads',
      titleZh: '剧情树与伏笔',
      titleEn: 'Plot tree and foreshadowing',
      onClick: () => goRail('plot-tree'),
    },
    {
      key: 'blueprint',
      icon: ListTree,
      zh: '蓝图',
      en: 'Blueprint',
      titleZh: '章节蓝图',
      titleEn: 'Chapter blueprint',
      onClick: () => goRail('blueprint'),
    },
    {
      // 先生：知识库挪到蓝图下面 —— 它更像"查阅用的库"，排在写作栏目之后更顺。
      key: 'knowledge',
      icon: BookOpen,
      zh: '知识库',
      en: 'Library',
      titleZh: '设定与知识库',
      titleEn: 'Settings and knowledge base',
      onClick: () => goRail('knowledge'),
    },
  ]

  const bottomItems: Array<SpineItem & { tab: BottomTab }> = [
    {
      key: 'tasks',
      tab: 'tasks',
      icon: ListChecks,
      zh: '任务',
      en: 'Tasks',
      titleZh: '创作任务',
      titleEn: 'Creative tasks',
      onClick: () => setBottomTab('tasks'),
    },
    {
      key: 'log',
      tab: 'log',
      icon: ScrollText,
      zh: '日志',
      en: 'Logs',
      titleZh: '运行日志',
      titleEn: 'Run logs',
      onClick: () => setBottomTab('log'),
    },
    {
      key: 'models',
      tab: 'models',
      icon: Cpu,
      zh: '模型',
      en: 'Models',
      titleZh: '模型调用',
      titleEn: 'Model activity',
      onClick: () => setBottomTab('models'),
    },
  ]

  const renderButton = (
    { key, icon: Icon, zh, en, titleZh, titleEn, onClick }: SpineItem,
    active: boolean,
    pulse = false,
  ) => (
    <button
      key={key}
      type="button"
      className={`sbtn${active ? ' on' : ''}`}
      title={text(titleZh, titleEn)}
      onClick={onClick}
    >
      <Icon size={18.5} strokeWidth={active ? 1.9 : 1.6} />
      <span>{text(zh, en)}</span>
      {pulse && <span className="pdot" />}
    </button>
  )

  const tasksRunning = !!currentRun && (currentRun.status === 'running' || currentRun.status === 'waiting')

  return (
    <nav className="spine v2-spine no-select" aria-label={text('主导航', 'Main navigation')}>
      {mainItems.map((item) => renderButton(item, activeRailItem === item.key))}

      <div className="sgrow" />
      <div className="sdiv" />

      {bottomItems.map((item) =>
        renderButton(item, activeRailItem === item.tab, item.key === 'tasks' && tasksRunning),
      )}

      <button
        type="button"
        className={`sbtn${activeRailItem === 'settings' || settingsOpen ? ' on' : ''}`}
        title={text('设置', 'Settings')}
        onClick={() => openSettings()}
      >
        <Settings size={18.5} strokeWidth={1.6} />
        <span>{text('设置', 'Settings')}</span>
      </button>
    </nav>
  )
}
