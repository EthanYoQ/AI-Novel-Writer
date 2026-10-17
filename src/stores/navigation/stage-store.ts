import { create } from 'zustand'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import type { ChapterFacts } from './stage-progress'

/** 运行侧页的分页：进行中（步骤、实时输出、等确认、可恢复）、历史、诊断（宽版：日志与模型调用）。 */
export type RunSheetTab = 'active' | 'history' | 'diagnostics'

/**
 * 内容区右侧的按需侧页，同一时间只开一个。运行侧页的 runId 是要看的那次运行：还在运行就在「进行中」里定位，已结束就在「历史」里展开它。
 * 审稿侧页由单章视图摆出，内容是 filePath 那一稿的审稿报告；换到别的稿时它不跟过去，各稿按自己的阶段决定是否默认展开。
 */
export type StageSheet = { kind: 'run'; tab: RunSheetTab; runId?: string } | { kind: 'review'; filePath: string }

/** 命令面板：commands 是搜索与跳转（⌘K / Ctrl K），chapters 只查章节（⌘P / Ctrl P）。 */
export type StagePalette = 'commands' | 'chapters'

/** 流程脊从项目数据派生状态时用到、而 project-store 与 draft-store 里没有的两项。 */
export interface StageWork {
  /** 这份数据属于哪次打开；同一路径重新打开是新的会话，旧数据不能当新的用。 */
  session: ProjectSessionContext
  /** 故事前提、角色名单、世界观、情节大纲是否已有内容。 */
  architecture: Readonly<Record<string, boolean>>
  blueprints: readonly { chapterNumber: number; title: string }[]
}

interface StageState {
  sheet: StageSheet | null
  /** 沉浸写作：只留正文与章节动作条。 */
  focus: boolean
  palette: StagePalette | null
  work: StageWork | null
  /** 有未保存修改、等作者确认是否放弃的待关闭标签。 */
  closingTabId: string | null
  /** 要为这一章打开写作弹层（定稿后打开下一章等）；挂着这一章写作按钮的页面接手后清空。只属于发出时的那次打开，换作品或重新打开即清掉。 */
  writeRequest: { session: ProjectSessionContext; chapterNumber: number } | null
  /** 审稿或修稿刚生成，要这一稿的单章视图重读数据；视图接手后清空。只属于发出时的那次打开，换作品或重新打开即清掉。 */
  chapterRequest: { session: ProjectSessionContext; filePath: string } | null
  /** 各稿的审稿与修稿记录（按稿 id），流程脊与单章视图据此判断一章走到哪一步；只属于读出它的那次打开。 */
  chapterFacts: { session: ProjectSessionContext; byDraft: Readonly<Record<number, ChapterFacts>> } | null
  /** 流程脊为这次打开读完过一遍各稿的审稿与修稿记录。没读完时流程脊不列阶段与章节，章节阶段不会先按稿状态估计再改。 */
  spineFacts: ProjectSessionContext | null
}

/** 外壳的界面状态。书房与作品的切换在 layout-store 的 sidebarView。 */
export const useStageStore = create<StageState>()(() => ({
  sheet: null,
  focus: false,
  palette: null,
  work: null,
  closingTabId: null,
  writeRequest: null,
  chapterRequest: null,
  chapterFacts: null,
  spineFacts: null,
}))
