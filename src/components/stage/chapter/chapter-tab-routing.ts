import type { DraftMeta } from '../../../services/draft-index'
import { chapterTabName } from '../../../shared/chapter-label'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'
import { isResourceUri, parseResourceUri } from '../../../shared/project-paths'
import { getActiveProjectSessionContext, sameProjectPathKey, sameProjectSessionContext } from '../../../shared/project-session-context'
import { fetchChapterDrafts, useDraftStore } from '../../../stores/draft-store'
import { useEditorStore, type EditorTab } from '../../../stores/editor-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { displayedErrorMessage } from '../../../i18n/app-errors'
import { chapterNavigationEpoch, chapterPlanTabId, openChapter } from '../../../stores/navigation/stage-navigation'
import { useStageStore } from '../../../stores/navigation/stage-store'
import { openDraftTab } from '../../../stores/open-draft-tab'
import { toast } from '../../ui/Toast'

export const RECOVERY_PREFIX = 'ai-novel://recovery/'

/** 助手 open_editor 或产物卡按作品目录里的路径打开的章节、大纲：不是数据库资源，没有对应的纸墨页面，只读显示。 */
export function isProjectFileTab(tab: EditorTab): boolean {
  return (tab.type === 'chapter' || tab.type === 'outline') && Boolean(tab.filePath) && !isResourceUri(tab.filePath!)
}

/** 不由单章视图承接的正文标签：运行侧页「继续编辑」打开的恢复候选、已经合并或放弃只能查看的修稿，与作品目录里的文件。 */
export function isProseDocumentTab(tab: EditorTab): boolean {
  return tab.type === 'chapter' && Boolean(tab.filePath?.startsWith(RECOVERY_PREFIX) || tab.filePath?.startsWith('ai-novel://revision/'))
    || isProjectFileTab(tab)
}

/** 正文类标签里由单章视图承接的：一稿草稿或定稿（ai-novel://draft/、ai-novel://manuscript/），以及待写章（没有 filePath）。 */
export function isChapterViewTab(tab: EditorTab): boolean {
  if (tab.type !== 'chapter') return false
  if (!tab.filePath) return tab.chapterNumber !== undefined
  const kind = parseResourceUri(tab.filePath)?.kind
  return kind === 'draft' || kind === 'manuscript'
}

/**
 * 在 tabId 那个标签的位置换上另一稿或待写章：open 打开（或切到）新标签后，关掉旧标签并把新标签挪到旧位置。
 * open 返回 false（读取失败、会话已变）时什么也不动。旧标签有未保存修改时由调用方先保存或请作者确认（放弃时照常关掉）；
 * 打开新标签期间作者又在旧标签里打了字，那些字没人确认过，旧标签就留着不关，并提示一句。
 */
export async function swapChapterTab(tabId: string, open: () => Promise<boolean> | boolean): Promise<void> {
  const tabs = useEditorStore.getState().tabs
  const index = tabs.findIndex(tab => tab.id === tabId)
  const before = tabs[index]?.content
  if (!(await open())) return
  const opened = useEditorStore.getState().activeTabId
  if (!opened || opened === tabId) return
  const old = useEditorStore.getState().tabs.find(tab => tab.id === tabId)
  if (old?.dirty && old.content !== before) {
    const text = useLocaleStore.getState().text
    toast.warning(text('原来那一稿在切换时又有了修改，它的标签留着，请保存后再关闭。', 'The previous draft changed while switching, so its tab stays open. Save it before closing.'))
    return
  }
  useEditorStore.getState().closeTab(tabId)
  if (index < 0) return
  useEditorStore.setState(state => {
    const tab = state.tabs.find(candidate => candidate.id === opened)
    if (!tab) return state
    const rest = state.tabs.filter(candidate => candidate !== tab)
    rest.splice(Math.min(index, rest.length), 0, tab)
    return { tabs: rest, activeTabId: opened }
  })
}

/** 这一章的某一稿在单章视图里打开（已开就切过去），标签名按章号与蓝图标题。 */
export function openDraftInChapterView(draft: DraftMeta, title: string, session: ProjectSessionContext): Promise<boolean> {
  return openDraftTab(draft, chapterTabName(draft.chapterNumber, title, useLocaleStore.getState().text), session)
}

async function showDraft(filePath: string, chapterNumber: number, session: ProjectSessionContext): Promise<void> {
  const editor = useEditorStore.getState()
  const open = editor.tabs.find(tab => tab.type === 'chapter' && tab.projectKey === session.projectPath && tab.filePath === filePath)
  if (open) {
    editor.setActiveTab(open.id)
    return
  }
  // 作者从这里起有没有去过别处：切过标签（哪怕又切回原处，只比较前后两刻看不出来）或点了章、阶段、资料页（那边可能还在读，标签没变）。
  const epoch = chapterNavigationEpoch()
  let switched = false
  const unsubscribe = useEditorStore.subscribe((state, previous) => {
    if (state.activeTabId !== previous.activeTabId) switched = true
  })
  try {
    const draft = (await fetchChapterDrafts(chapterNumber, session)).find(candidate => candidate.filePath === filePath)
    if (!draft) {
      // 指向的稿已经删掉，标签也已关掉：说明一句，落到这一章现在的稿（没有稿就是待写页），而不是什么也不打开。
      // 读稿期间换了作品就不再动；作者去过别处，一直到真正打开前都不把他拉回这一章。
      if (!sameProjectSessionContext(session, getActiveProjectSessionContext())) return
      if (useStageStore.getState().chapterRequest?.filePath === filePath) useStageStore.setState({ chapterRequest: null })
      const stayed = () => !switched
      const opened = stayed() && chapterNavigationEpoch() === epoch && await openChapter(chapterNumber, stayed)
      if (!sameProjectSessionContext(session, getActiveProjectSessionContext())) return
      const text = useLocaleStore.getState().text
      toast.warning(opened
        ? text(`第 ${chapterNumber} 章这一稿已被删除，已打开这一章现在的内容。`, `That draft of chapter ${chapterNumber} was deleted. Opened the chapter's current content instead.`)
        : text(`第 ${chapterNumber} 章这一稿已被删除。`, `That draft of chapter ${chapterNumber} was deleted.`))
      return
    }
    const plan = useEditorStore.getState().tabs.find(tab => tab.id === chapterPlanTabId(chapterNumber, session.projectPath))
    const opener = () => openDraftInChapterView(draft, draft.chapterTitle ?? '', session)
    if (plan) await swapChapterTab(plan.id, opener)
    else await opener()
  } finally {
    unsubscribe()
  }
}

/**
 * 审稿报告与修稿合并不是独立标签，而是单章视图的侧页与合并视图（ia.md）。
 * 工作流命令仍会打开 review-report 与 diff 标签；这里把它们改道：关掉那个标签，
 * 切到（或打开）这一稿的单章视图，并请它重读数据、展开审稿侧页或合并视图。
 * 草稿生成后自动打开的草稿标签（F-061）顶替同一章的待写标签，留在原位置。
 * 只处理当前作品的标签；版本历史的只读对比（diff 标签不带 revisionPath）不改道。
 */
export function installChapterTabRouting(): () => void {
  let handling = false
  return useEditorStore.subscribe((state, previous) => {
    if (handling) return
    const session = getActiveProjectSessionContext()
    if (!session) return
    const active = state.tabs.find(tab => tab.id === state.activeTabId)
    if (!active || !active.projectKey || !sameProjectPathKey(active.projectKey, session.projectPath)) return
    const activated = state.activeTabId !== previous.activeTabId || previous.tabs.find(tab => tab.id === active.id) !== active

    const target = active.filePath ? parseResourceUri(active.filePath) : null
    const routed = activated && target?.kind === 'draft' && active.chapterNumber !== undefined
      && (active.type === 'review-report' || (active.type === 'diff' && Boolean(active.revisionPath)))
    if (routed && active.filePath && active.chapterNumber !== undefined) {
      handling = true
      try {
        useEditorStore.getState().closeTab(active.id)
        useStageStore.setState({ chapterRequest: { session, filePath: active.filePath } })
      } finally {
        handling = false
      }
      const chapterNumber = active.chapterNumber
      // 改道时那个标签已经关了：读不出这一章的稿就告诉作者，不能什么也不打开。
      void showDraft(active.filePath, chapterNumber, session).catch(error => {
        const { locale, text } = useLocaleStore.getState()
        const reason = displayedErrorMessage(locale, error)
        toast.error(text(`打开第 ${chapterNumber} 章失败：${reason}`, `Could not open chapter ${chapterNumber}: ${reason}`))
      })
      return
    }

    const isNewDraft = active.type === 'chapter' && target?.kind === 'draft' && !previous.tabs.some(tab => tab.id === active.id)
    if (!isNewDraft) return
    const chapterNumber = active.chapterNumber ?? Object.values(useDraftStore.getState().draftsByChapter).flat().find(draft => draft.filePath === active.filePath)?.chapterNumber
    if (chapterNumber === undefined) return
    const planId = chapterPlanTabId(chapterNumber, session.projectPath)
    if (!state.tabs.some(tab => tab.id === planId)) return
    handling = true
    try {
      void swapChapterTab(planId, () => true)
    } finally {
      handling = false
    }
  })
}
