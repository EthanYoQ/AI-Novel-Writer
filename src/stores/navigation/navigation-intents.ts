import type { ChapterWritePrefill, SettingsSection } from '../layout-store'
import { stageNavigate } from './stage-navigation'

/** 作品流程脊的四个阶段，顺序即创作顺序。 */
export type WorkStage = 'setup' | 'architecture' | 'blueprint' | 'manuscript'

/** 流程脊下方的作品资料页。 */
export type ResourcePage = 'plot' | 'knowledge' | 'history'

/** 运行侧页的分页：实时输出、任务进度、诊断里的日志与模型调用。 */
export type RunPaneFacet = 'output' | 'tasks' | 'log' | 'models'

/** 跨层导航意图。调用方只描述要去哪里，由 stageNavigate 决定落到哪些界面状态。 */
export type NavigationIntent =
  /** 不带 stage 表示回到作品的流程脊，不切换内容页。 */
  | { kind: 'stage'; stage?: WorkStage }
  | { kind: 'resource'; page: ResourcePage }
  | { kind: 'run'; facet: RunPaneFacet; runId?: string }
  | { kind: 'settings'; section: SettingsSection }
  /** 带 write 时打开这一章，并由单章视图弹出写作此章的弹层。 */
  | { kind: 'chapter'; chapterNumber: number; write?: ChapterWritePrefill }

/** 唯一的跨层导航入口。 */
export function navigate(intent: NavigationIntent): void {
  stageNavigate(intent)
}
