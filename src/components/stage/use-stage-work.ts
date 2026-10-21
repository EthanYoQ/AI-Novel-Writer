import { useEffect, useMemo, useRef } from 'react'
import { checkArchConfirmed } from '../../services/architecture-service'
import { ipc } from '../../services/ipc-client'
import { globalEventBus } from '../../shared/event-bus'
import { sameProjectPathKey, sameProjectSessionContext } from '../../shared/project-session-context'
import { useDraftStore } from '../../stores/draft-store'
import { useEditorStore } from '../../stores/editor-store'
import { useLocaleStore } from '../../stores/locale-store'
import { displayedErrorMessage } from '../../i18n/app-errors'
import {
  deriveChapters, deriveStages, landingStage, locate, missingSetup, runningChapters,
  type ChapterRow, type StageLocation, type StageStatus,
} from '../../stores/navigation/stage-progress'
import { refreshChapterFacts } from '../../stores/navigation/chapter-facts'
import { useStageStore } from '../../stores/navigation/stage-store'
import { navigate, type WorkStage } from '../../stores/navigation/navigation-intents'
import { useProjectStore } from '../../stores/project-store'
import { useWorkflowStore, type WorkflowRun } from '../../stores/workflow-store'
import { shouldRefreshBlueprints } from '../editor/blueprint-refresh'
import { captureProjectSession, isProjectSessionCurrent } from '../project-session-gate'
import { toast } from '../ui/Toast'

let refreshSequence = 0

/**
 * 读一次流程脊需要而 project-store、draft-store 里没有的数据：架构四节是否已确认、蓝图章号与标题；草稿顺带刷新。
 * 只认最后一次请求，项目会话或会话代数变了就丢弃结果。
 */
export async function refreshStageWork(text: (zh: string, en: string) => string): Promise<void> {
  const { currentProject, projectSessionEpoch } = useProjectStore.getState()
  const session = captureProjectSession(currentProject)
  const request = ++refreshSequence
  if (!session) {
    useStageStore.setState({ work: null })
    return
  }
  const current = () => request === refreshSequence && isProjectSessionCurrent(session)
    && useProjectStore.getState().projectSessionEpoch === projectSessionEpoch
  try {
    const [architecture, blueprints] = await Promise.all([
      checkArchConfirmed(session, currentProject?.novelConfig),
      ipc.invokeWithProjectSession(session, 'db:blueprint-get-all', session.projectPath),
      useDraftStore.getState().loadAllDrafts(session.projectPath, session),
    ])
    if (!current()) return
    const chapters = blueprints.map(({ chapterNumber, title }) => ({ chapterNumber, title }))
    const working = deriveChapters({ blueprints: chapters, drafts: useDraftStore.getState().draftsByChapter, runningChapters: new Set() })
      .flatMap(row => row.draft && row.draft.status !== 'finalized' ? [row.draft] : [])
    // 落点只看章是否待写或定稿，不需要 facts，所以先出 work；流程脊等 spineFacts。主进程按到达顺序处理读取：
    // 等一个任务，让落点先把那一章的正文读取发出去，facts 排在它后面。
    useStageStore.setState({ work: { session, architecture, blueprints: chapters } })
    await new Promise(resolve => setTimeout(resolve, 0))
    if (!current()) return
    await refreshChapterFacts(working, session)
    if (current()) useStageStore.setState({ spineFacts: session })
  } catch (error) {
    const reason = displayedErrorMessage(useLocaleStore.getState().locale, error)
    if (current()) toast.error(text(`项目资源刷新失败：${reason}`, `Could not refresh project resources: ${reason}`))
  }
}

/** 任一运行的状态或步骤状态变化都要重新读。 */
function workflowRefreshKey(runs: readonly WorkflowRun[]): string {
  return runs.map(run => `${run.id}:${run.status}|${run.steps.map(step => step.status).join(',')}`).join(';')
}

/**
 * 换项目或会话代数变化时立即刷新；工作流步骤推进、架构更新、蓝图资源变化时合并成一次。
 * 项目身份与工作流共用一个 effect，打开作品时只刷新一次。
 */
export function useStageWorkRefresh(): void {
  const projectPath = useProjectStore(s => s.currentProject?.path)
  const epoch = useProjectStore(s => s.projectSessionEpoch)
  const workflowKey = useWorkflowStore(s => workflowRefreshKey(s.activeRuns))
  const identity = projectPath === undefined ? null : `${projectPath}\n${epoch}`
  const refreshedIdentity = useRef<string | null | undefined>(undefined)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const schedule = useRef(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      void refreshStageWork(useLocaleStore.getState().text)
    }, 80)
  })

  useEffect(() => {
    if (refreshedIdentity.current !== identity) {
      refreshedIdentity.current = identity
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
      void refreshStageWork(useLocaleStore.getState().text)
      return
    }
    if (identity !== null) schedule.current()
  }, [identity, workflowKey])

  useEffect(() => {
    const offArch = globalEventBus.on('ARCH_FILE_UPDATED', ({ projectSession }) => {
      if (isProjectSessionCurrent(projectSession)) schedule.current()
    })
    const offResource = globalEventBus.on('REFRESH_RESOURCE', ({ projectSession, resources }) => {
      if (isProjectSessionCurrent(projectSession) && shouldRefreshBlueprints(resources)) schedule.current()
    })
    return () => {
      offArch()
      offResource()
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])
}

export interface StageView {
  stages: StageStatus[]
  chapters: ChapterRow[]
  location: StageLocation | null
  /** 打开作品时该落到的阶段：架构、蓝图与草稿都已按当前项目会话载入、且草稿不在重新载入中才有，不等各稿的审稿与修稿记录。 */
  landing: WorkStage | null
}

/** 这部作品正在生成的章号，排好序拼成字符串：运行进度每跳一次，只要涉及的章没变，键就不变。 */
function runningKey(runs: readonly WorkflowRun[], projectPath: string | undefined): string {
  if (!projectPath) return ''
  return [...runningChapters(runs.filter(run => sameProjectPathKey(run.projectPath, projectPath)))].sort((a, b) => a - b).join(',')
}

/** 当前标签所在的位置。只订阅类型、章号与所属项目这几个原始值，正文每敲一个字外壳不跟着重渲染。 */
function useActiveLocation(projectPath: string | undefined): StageLocation | null {
  const type = useEditorStore(s => s.tabs.find(tab => tab.id === s.activeTabId)?.type)
  const chapterNumber = useEditorStore(s => s.tabs.find(tab => tab.id === s.activeTabId)?.chapterNumber)
  const projectKey = useEditorStore(s => s.tabs.find(tab => tab.id === s.activeTabId)?.projectKey)
  return useMemo(() => projectPath && type && projectKey === projectPath ? locate({ type, chapterNumber }) : null,
    [projectPath, type, chapterNumber, projectKey])
}

const NO_STAGES: StageStatus[] = []
const NO_CHAPTERS: ChapterRow[] = []

export function useStageView(): StageView {
  const project = useProjectStore(s => s.currentProject)
  const work = useStageStore(s => s.work)
  const factsState = useStageStore(s => s.chapterFacts)
  const spineFacts = useStageStore(s => s.spineFacts)
  const draftsByChapter = useDraftStore(s => s.draftsByChapter)
  const draftSession = useDraftStore(s => s.dataProjectSession)
  const draftsLoading = useDraftStore(s => s.loading)
  const running = useWorkflowStore(s => runningKey(s.activeRuns, project?.path))
  const location = useActiveLocation(project?.path)
  const session = captureProjectSession(project)

  const currentWork = session && work && sameProjectSessionContext(work.session, session) ? work : null
  const drafts = session && sameProjectSessionContext(draftSession, session) ? draftsByChapter : null
  const chapterFacts = session && factsState && sameProjectSessionContext(factsState.session, session) ? factsState.byDraft : undefined
  const runningChapterSet = useMemo(() => new Set(running ? running.split(',').map(Number) : []), [running])

  const chapters = useMemo(() => currentWork && drafts
    ? deriveChapters({ blueprints: currentWork.blueprints, drafts, runningChapters: runningChapterSet, chapterFacts })
    : [], [currentWork, drafts, runningChapterSet, chapterFacts])
  const stages = useMemo(() => project && currentWork && drafts
    ? deriveStages({ config: project.novelConfig, architecture: currentWork.architecture, blueprints: currentWork.blueprints, drafts, runningChapters: runningChapterSet }, chapters)
    : [], [project, currentWork, drafts, runningChapterSet, chapters])
  const settled = Boolean(currentWork && drafts && !draftsLoading)
  // 记录读完前章节阶段只能按稿状态估计，会先错后改，所以流程脊与命令面板先空着；落点不受影响。
  const shown = Boolean(session && spineFacts && sameProjectSessionContext(spineFacts, session))
  return {
    stages: shown ? stages : NO_STAGES,
    chapters: shown ? chapters : NO_CHAPTERS,
    location,
    landing: settled ? landingStage(stages) : null,
  }
}

/**
 * 打开作品时把内容区放到下一步：设定没填完就停在设定，否则等架构、蓝图与草稿载入后落到第一个未完成的阶段。
 * 每次打开（项目会话）只落一次；这次打开已有标签时保持原样。
 */
export function useLandingPage(view: StageView): void {
  const project = useProjectStore(s => s.currentProject)
  const landed = useRef<string | null>(null)
  useEffect(() => {
    const session = captureProjectSession(project)
    if (!project || !session) return
    const key = `${session.projectId}\n${session.leaseId}`
    if (landed.current === key) return
    if (useEditorStore.getState().tabs.some(tab => tab.projectKey === session.projectPath)) {
      landed.current = key
      return
    }
    if (missingSetup(project.novelConfig).length > 0) {
      landed.current = key
      navigate({ kind: 'stage', stage: 'setup' })
      return
    }
    if (!view.landing) return
    landed.current = key
    navigate({ kind: 'stage', stage: view.landing })
  }, [project, view.landing])
}
