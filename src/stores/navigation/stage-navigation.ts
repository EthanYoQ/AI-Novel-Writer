import { leaveSettings, leaveSettingsThen } from '../../components/settings/unsaved-settings'
import { toast } from '../../components/ui/Toast'
import type { DraftMeta } from '../../services/draft-index'
import { chapterTabName } from '../../shared/chapter-label'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../shared/project-session-context'
import { fetchChapterDrafts, useDraftStore } from '../draft-store'
import { createProjectScopedEditorTabId, useEditorStore } from '../editor-store'
import { useLayoutStore } from '../layout-store'
import { useLocaleStore } from '../locale-store'
import { displayedErrorMessage } from '../../i18n/app-errors'
import { openDraftTab } from '../open-draft-tab'
import { useProjectStore } from '../project-store'
import type { NavigationIntent } from './navigation-intents'
import { openPageTab } from './page-tabs'
import { deriveChapters, focusChapter } from './stage-progress'
import { useStageStore } from './stage-store'

/**
 * 回到作品：离开书房、退出沉浸。不收起搜索：搜索是模态层，作者在里面选中一项时它自己先关；
 * 搜索开着时还能到这里的只有自动跳转（打开作品后的落点、工作流开始时打开运行侧页），它们不该关掉作者正在输入的搜索。
 */
function enterWork(): void {
  useStageStore.setState({ focus: false })
  if (useLayoutStore.getState().sidebarView === 'home') useLayoutStore.setState({ sidebarView: 'project' })
}

function currentSession(): ProjectSessionContext | null {
  return projectSessionContextFromProject(useProjectStore.getState().currentProject)
}

/** 草稿 store 已按这次会话完整载入时直接用它；否则单独读这一章，不依赖可能被新一轮 loadAllDrafts 作废的载入。 */
async function chapterDrafts(chapterNumber: number, session: ProjectSessionContext): Promise<readonly DraftMeta[]> {
  const loaded = useDraftStore.getState()
  if (sameProjectSessionContext(loaded.dataProjectSession, session) && !loaded.loading) return loaded.draftsByChapter[chapterNumber] ?? []
  return fetchChapterDrafts(chapterNumber, session)
}

let openChapterRequest = 0

/** 章节导航的序号：作者每点一次章、阶段或资料页就变。自动打开在等待期间看到它变了，就是作者已经去了别处。 */
export function chapterNavigationEpoch(): number {
  return openChapterRequest
}

/** 待写章的单章视图标签：还没有稿，所以没有 filePath，按章号区分；与其他正文标签一样按作品加后缀。 */
export function chapterPlanTabId(chapterNumber: number, projectPath: string): string {
  return createProjectScopedEditorTabId(`chapter-plan:${chapterNumber}`, 'chapter', projectPath)
}

/** 打开待写章的单章视图：显示本章蓝图与「写作此章」。草稿生成后换成草稿标签。 */
export function openChapterPlan(chapterNumber: number, title: string, session: ProjectSessionContext): void {
  const text = useLocaleStore.getState().text
  useEditorStore.getState().openFile({
    id: `chapter-plan:${chapterNumber}`,
    name: chapterTabName(chapterNumber, title, text),
    type: 'chapter',
    chapterNumber,
    projectKey: session.projectPath,
    projectSessionLease: session.leaseId,
  })
}

/**
 * 打开一章：已有这一稿的标签就直接切过去；否则读出正文开新标签。待写的章还没有正文，打开它的单章视图，那里有「写作此章」。
 * 连续点几章时只有最后一次生效；读取失败时提示作者，而不是点了没反应。
 * 自动打开传入 stillIntended，读取期间它变成 false 就放弃。返回这一章最后有没有切到前台。
 */
export async function openChapter(chapterNumber: number, stillIntended: () => boolean = () => true): Promise<boolean> {
  const request = ++openChapterRequest
  const session = currentSession()
  if (!session) return false
  const text = useLocaleStore.getState().text
  const stillWanted = () => request === openChapterRequest && sameProjectSessionContext(session, currentSession()) && stillIntended()
  try {
    const drafts = await chapterDrafts(chapterNumber, session)
    if (!stillWanted()) return false
    const work = useStageStore.getState().work
    const [row] = deriveChapters({
      blueprints: (work && sameProjectSessionContext(work.session, session) ? work.blueprints : [])
        .filter(blueprint => blueprint.chapterNumber === chapterNumber),
      drafts: { [chapterNumber]: drafts },
      runningChapters: new Set(),
    })
    const draft = row?.draft
    if (!draft) {
      openChapterPlan(chapterNumber, row?.title ?? '', session)
      return true
    }
    // 已经有稿的章没有写作此章；写作请求（比如定稿后自动打开下一章）落空，不能留到别处再弹出。
    if (useStageStore.getState().writeRequest?.chapterNumber === chapterNumber) useStageStore.setState({ writeRequest: null })
    const editor = useEditorStore.getState()
    const open = editor.tabs.find(tab => tab.type === 'chapter' && tab.projectKey === session.projectPath && tab.filePath === draft.filePath)
    if (open) {
      editor.setActiveTab(open.id)
      return true
    }
    return await openDraftTab(draft, chapterTabName(chapterNumber, row.title, text), session, stillWanted)
  } catch (error) {
    if (!stillWanted()) return false
    const reason = displayedErrorMessage(useLocaleStore.getState().locale, error)
    toast.error(text(`打开第 ${chapterNumber} 章失败：${reason}`, `Could not open chapter ${chapterNumber}: ${reason}`))
    return false
  }
}

// 写作与重读请求可能在接手的页面挂载前一直留着（比如作者在书房里）；换作品或重新打开后，它们不能落在新作品的同一章上。
// 审稿侧页按稿的 filePath 归属，稿 id 在各作品里各自递增会撞，换作品或重新打开时一并收起。
useProjectStore.subscribe(({ currentProject }, previous) => {
  const session = projectSessionContextFromProject(currentProject)
  const { writeRequest, chapterRequest, sheet } = useStageStore.getState()
  if (writeRequest && !sameProjectSessionContext(writeRequest.session, session)) useStageStore.setState({ writeRequest: null })
  if (chapterRequest && !sameProjectSessionContext(chapterRequest.session, session)) useStageStore.setState({ chapterRequest: null })
  if (sheet?.kind === 'review' && !sameProjectSessionContext(projectSessionContextFromProject(previous.currentProject), session)) useStageStore.setState({ sheet: null })
})

function openKnowledge(): void {
  const projectKey = useProjectStore.getState().currentProject?.path
  if (!projectKey) return
  const text = useLocaleStore.getState().text
  useEditorStore.getState().openFile({ id: 'knowledge-base', name: text('知识库', 'Knowledge base'), type: 'knowledge', projectKey })
}

/** 正文阶段本身没有页面，落到当前该写的那一章；还没有任何章时先去蓝图。 */
async function openManuscript(): Promise<void> {
  const session = currentSession()
  const work = useStageStore.getState().work
  if (!session || !work || !sameProjectSessionContext(work.session, session)) {
    openPageTab('blueprint')
    return
  }
  const drafts = useDraftStore.getState()
  const target = focusChapter(deriveChapters({
    blueprints: work.blueprints,
    drafts: sameProjectSessionContext(drafts.dataProjectSession, session) ? drafts.draftsByChapter : {},
    runningChapters: new Set(),
  }))
  if (target) await openChapter(target.number)
  else openPageTab('blueprint')
}

/**
 * 各意图的落点。设置是内容面板里的设置页。
 * 写作此章打开这一章的单章视图，由那里的写作按钮弹出写作弹层；参数取自蓝图，不再弹旧的创作对话框。
 */
export function stageNavigate(intent: NavigationIntent): void {
  if (intent.kind === 'settings') {
    const open = () => useLayoutStore.setState({ settingsOpen: true, settingsSection: intent.section })
    const { settingsOpen, settingsSection } = useLayoutStore.getState()
    // 设置页开着时换分区会卸掉当前分区的输入，与设置页里点侧栏换页一样先确认。
    if (settingsOpen && settingsSection !== intent.section) leaveSettings(open)
    else open()
    return
  }
  if (intent.kind === 'chapter' && intent.write) {
    const { chapterNumber } = intent
    leaveSettingsThen(() => {
      const session = currentSession()
      if (session) useStageStore.setState({ writeRequest: { session, chapterNumber } })
      arrive(intent)
    })
    return
  }
  // 去具体的阶段、资料页或章节，或从书房进作品，都会收起设置页，有没保存的输入时先确认；
  // 已在作品里时只回到作品（打开作品后的默认落点）或打开运行侧页，设置页留着。
  const staysInSettings = (intent.kind === 'run' || (intent.kind === 'stage' && !intent.stage))
    && useLayoutStore.getState().sidebarView !== 'home'
  if (staysInSettings) arrive(intent)
  else leaveSettingsThen(() => arrive(intent))
}

function arrive(intent: Exclude<NavigationIntent, { kind: 'settings' }>): void {
  enterWork()
  // 去别的阶段或资料页是作者新的选择：还在读正文的那一章读完后不再抢回标签。
  if ((intent.kind === 'stage' && intent.stage) || intent.kind === 'resource') openChapterRequest++
  switch (intent.kind) {
    case 'stage':
      if (!intent.stage) {
        // 回到作品只收起运行侧页。审稿侧页属于单章视图：打开作品落在已审稿的章时它按这一章默认展开，不能随后又被收起。
        if (useStageStore.getState().sheet?.kind === 'run') useStageStore.setState({ sheet: null })
      } else if (intent.stage === 'manuscript') void openManuscript()
      else openPageTab(intent.stage)
      return
    case 'resource':
      if (intent.page === 'knowledge') openKnowledge()
      else openPageTab(intent.page)
      return
    case 'run':
      useStageStore.setState({ sheet: { kind: 'run', tab: intent.facet === 'log' || intent.facet === 'models' ? 'diagnostics' : 'active', runId: intent.runId } })
      return
    case 'chapter':
      void openChapter(intent.chapterNumber)
  }
}
