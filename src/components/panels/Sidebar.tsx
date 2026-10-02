/**
 * Sidebar — 左侧导航面板容器
 *
 * 纯路由容器，根据 sidebarView 切换子视图。
 * 所有子视图已拆分到 sidebar/ 子目录。
 *
 * v2 的补充规则（先生）：**还没打开作品时，侧栏不再显示任何栏目的正文型内容**，
 * 只给「该栏目自己的图标 + 请先打开项目」—— 与人物 / 知识库既有的表现一致。
 * 正文栏此时一直停在书架首页，于是两栏的行为对得上：栏目只切侧栏的图标与标题，
 * 正文栏不跟着跳。
 */

import { useState, useEffect } from 'react'
import { BookOpen, GitBranch, Globe2, List, ListTree, Users, type LucideIcon } from 'lucide-react'
import { useLayoutStore } from '../../stores/layout-store'
import { useProjectStore } from '../../stores/project-store'
import { ContextMenu } from '../ui/ContextMenu'
import { EmptyState } from '../ui/EmptyState'
import KnowledgePanel from './KnowledgePanel'
import WorldSettingSidebarPanel from './sidebar/WorldSettingSidebarPanel'
import HomeSidebarPanel from './sidebar/HomeSidebarPanel'
import ProjectTree from './sidebar/ProjectTree'
import CharactersView from './sidebar/CharactersView'
import {
  registerMenuSetter, unregisterMenuSetter,
  type SidebarMenuState,
} from './sidebar/sidebar-menu'
import { useLocaleStore } from '../../stores/locale-store'
import { useUiVersionStore, isMagazine } from '../../stores/ui-version-store'
import SectionSigil from '../layout/v2/magazine/SectionSigil'
import { sectionForRail } from '../../shared/section-opener'

/** 各栏目自己的图标：与书脊导航用的是同一套，空态与面板标题都取自这里。 */
const RAIL_ICONS: Record<string, LucideIcon> = {
  project: List,
  characters: Users,
  knowledge: BookOpen,
  world: Globe2,
  'plot-tree': GitBranch,
  blueprint: ListTree,
}

/** 左侧面板 */
export default function Sidebar() {
  const sidebarView = useLayoutStore(s => s.sidebarView)
  const activeRailItem = useLayoutStore(s => s.activeRailItem)
  const currentProject = useProjectStore(s => s.currentProject)
  const text = useLocaleStore(s => s.text)
  // 全局右键菜单状态
  const [sidebarMenu, setSidebarMenu] = useState<SidebarMenuState | null>(null)

  // 注册 / 注销右键菜单 setter
  useEffect(() => {
    registerMenuSetter(setSidebarMenu)
    return () => { unregisterMenuSetter() }
  }, [])

  const viewTitles: Record<string, string> = {
    home:        text('主页', 'Home'),
    project:     text('项目结构', 'Project'),
    knowledge:   text('知识库', 'Knowledge'),
    characters:  text('角色管理', 'Characters'),
    world:       text('设定集', 'World building'),
    'plot-tree': text('剧情树与伏笔', 'Plot tree & foreshadowing'),
    blueprint:   text('章节蓝图', 'Chapter blueprint'),
  }

  /**
   * 还没打开作品时：除书架栏目外，侧栏一律只给「图标 + 请先打开项目」。
   * 标题也按当前栏目取，否则点「世界 / 伏笔 / 蓝图」会顶着别人的名字。
   */
  const railOnly = !currentProject && activeRailItem !== 'home'
  const RailIcon = RAIL_ICONS[activeRailItem] ?? List
  const uiVersion = useUiVersionStore(s => s.uiVersion)
  /**
   * 空态图标 —— **2026-09-17 第十五轮换稿**。
   *
   * 先生：「没有点书的时候，目录、人物、设定、伏笔、蓝图、知识库，侧边栏中的
   * 『请先打开项目』上方的那些 logo……这几个 logo 现在看上去太老气。」
   *
   * 对。那是六个 Lucide 现成线条图标（`RAIL_ICONS`：List / Users / Globe2 /
   * GitBranch / ListTree / BookOpen），把线宽调到 1.7 就算换过了 —— 正是
   * 「不敢自己做点 SVG」那件事。而项目里**早就有一套自绘的七栏目徽记**
   * （`SectionSigil`：方点 + 直线，与全站方形色标同源，取当前栏目色），
   * 当初就写明「放在侧栏、标签页里也该取当前栏目色」，只是侧栏这一处没接上。
   * 这里把它接上：v3 出徽记，v2 / v1 仍是原来的线条图标（铁律三·分家）。
   */
  const railSection = sectionForRail(activeRailItem)

  return (
    <div
      className="skin-workspace-panel w-full h-full flex flex-col overflow-hidden"
      style={{
        backgroundColor: 'var(--color-sidebar)',
        borderRight: '1px solid var(--color-border)',
      }}
    >
      <div className="panel-header">
        <span>{viewTitles[activeRailItem] ?? viewTitles[sidebarView]}</span>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {railOnly ? (
          <EmptyState
            icon={
              isMagazine(uiVersion) && railSection
                ? <SectionSigil section={railSection.key} size={36} />
                : <RailIcon size={36} />
            }
            message={text('请先打开项目', 'Open a project first')}
            className="pb-[15vh]"
            opacity={0.4}
          />
        ) : (
          <>
            {sidebarView === 'home'       && <HomeSidebarPanel />}
            {sidebarView === 'project'    && <ProjectTree />}
            {/*
              先生：「世界」栏目原先借的是知识库视图，点「世界」看起来像弹出了知识库。
              这里按栏目分流 —— world 给世界观设定自己的面板（先占位说明），其余仍是知识库。
            */}
            {sidebarView === 'knowledge'  && <KnowledgePanel />}
            {/*
              先生：「世界」有自己的侧栏视图，不再借知识库的。
              原先两栏共用 sidebarView='knowledge'、靠 activeRailItem === 'world' 分流 ——
              可底部面板（任务 / 日志 / 模型）打开时会把 activeRailItem 抢走，
              侧栏于是掉回知识库面板（就是先生看到的那个 bug）。
              栏目各归各的视图之后，这条耦合就断了。
            */}
            {sidebarView === 'world'      && <WorldSettingSidebarPanel />}
            {sidebarView === 'characters' && <CharactersView />}
          </>
        )}
      </div>

      {/* 动态右键菜单 */}
      {sidebarMenu && (
        <ContextMenu
          items={sidebarMenu.items}
          position={sidebarMenu.position}
          onClose={() => setSidebarMenu(null)}
        />
      )}
    </div>
  )
}
