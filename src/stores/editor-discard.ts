import {
  CHAPTER_CARD_TAB_ID,
  discardChapterCardProjectDraft,
  parseChapterCardDraftLedger,
  persistChapterCardDraftLedger,
} from '../components/editor/chapter-card-draft-ledger'
import { useCharacterStore } from './character-store'
import { useEditorStore } from './editor-store'
import { useProjectStore } from './project-store'
import {
  CHARACTER_DRAFT_TAB,
  CONFIG_DRAFT_TAB,
  createEmptyProjectEditorDraftLedger,
  parseProjectEditorDraftLedger,
} from './project-editor-draft-ledger'
import type { ProjectSessionContext } from '../shared/ipc-channels'
import {
  projectSessionContextFromProject,
  sameProjectPathKey,
  sameProjectSessionContext,
} from '../shared/project-session-context'

function isExpectedProjectSessionCurrent(
  projectKey: string,
  expectedProjectSession: ProjectSessionContext,
): boolean {
  return sameProjectPathKey(projectKey, expectedProjectSession.projectPath)
    && sameProjectSessionContext(
      expectedProjectSession,
      projectSessionContextFromProject(useProjectStore.getState().currentProject),
    )
}

function discardDirtyTabs(dirtyTabIds: ReadonlySet<string>): void {
  useEditorStore.setState((state) => {
    const tabs = state.tabs
      .filter(tab => !dirtyTabIds.has(tab.id) || tab.pinned)
      .map(tab => (
        dirtyTabIds.has(tab.id) && tab.pinned
          ? {
              ...tab,
              content: tab.savedContent ?? tab.content,
              dirty: false,
            }
          : tab
      ))
    const activeTabId = state.activeTabId && dirtyTabIds.has(state.activeTabId)
      && !tabs.some(tab => tab.id === state.activeTabId)
      ? (tabs[tabs.length - 1]?.id ?? null)
      : state.activeTabId
    return { tabs, activeTabId }
  })
}

/**
 * 放弃一个可见编辑器的修改，并在恢复对应已保存基准后关闭它。
 *
 * 后台账本按项目删除；其他项目的草稿不受影响。
 */
export function discardAndCloseEditorTab(
  tabId: string,
  expectedProjectSession: ProjectSessionContext,
): void {
  const editor = useEditorStore.getState()
  const tab = editor.tabs.find(candidate => candidate.id === tabId)
  if (!tab || tab.pinned) return

  const projectKey = tab.projectKey
  if (projectKey) {
    if (
      !isExpectedProjectSessionCurrent(projectKey, expectedProjectSession)
      || (
        tab.projectSessionLease !== undefined
        && tab.projectSessionLease !== expectedProjectSession.leaseId
      )
    ) return
    if (tab.type === 'character') {
      useCharacterStore.getState().discardDraft(projectKey, expectedProjectSession)
    } else if (tab.type === 'config') {
      useProjectStore.getState().discardNovelConfigDraft(projectKey, expectedProjectSession)
    } else if (tab.type === 'chapter-card') {
      const ledger = parseChapterCardDraftLedger(
        useEditorStore.getState().draftLedgers[CHAPTER_CARD_TAB_ID],
      )
      persistChapterCardDraftLedger(
        useEditorStore.getState(),
        discardChapterCardProjectDraft(ledger, projectKey),
      )
    }
  }

  useEditorStore.getState().closeTab(tabId)
}

/**
 * 放弃当前项目的全部未保存编辑。
 *
 * 普通 Tab 通过关闭来丢弃组件内状态；不可关闭的固定 Tab 则恢复已保存内容并清除
 * dirty。角色、配置和章节蓝图的后台账本按项目清理，其他项目草稿保持不变。
 */
export function discardCurrentProjectEditorChanges(
  projectKey: string,
  expectedProjectSession: ProjectSessionContext,
): void {
  if (!isExpectedProjectSessionCurrent(projectKey, expectedProjectSession)) return
  const dirtyTabIds = new Set(
    useEditorStore.getState().tabs
      .filter(tab => (
        tab.dirty
        && (tab.projectKey === projectKey || tab.projectKey === undefined)
      ))
      .map(tab => tab.id),
  )
  useCharacterStore.getState().discardDraft(projectKey, expectedProjectSession)
  useProjectStore.getState().discardNovelConfigDraft(projectKey, expectedProjectSession)

  const editor = useEditorStore.getState()
  const chapterLedger = parseChapterCardDraftLedger(
    editor.draftLedgers[CHAPTER_CARD_TAB_ID],
  )
  persistChapterCardDraftLedger(
    editor,
    discardChapterCardProjectDraft(chapterLedger, projectKey),
  )

  discardDirtyTabs(dirtyTabIds)
}

/**
 * 放弃更新门禁统计到的全部未保存内容。
 *
 * 更新会退出整个应用，因此这里按所有项目清空，而不是只清当前项目。先通过各
 * 领域 store 恢复当前可见项目的保存基准，再强制清空三类后台账本；损坏账本也
 * 会被替换为空账本。最后关闭所有 dirty Tab，固定 Tab 恢复保存内容。
 */
export function discardAllEditorChanges(): void {
  const editorBeforeDiscard = useEditorStore.getState()
  const dirtyTabIds = new Set(
    editorBeforeDiscard.tabs.filter(tab => tab.dirty).map(tab => tab.id),
  )
  const characterLedger = parseProjectEditorDraftLedger<unknown>(
    editorBeforeDiscard.draftLedgers[CHARACTER_DRAFT_TAB.id],
  )
  const configLedger = parseProjectEditorDraftLedger<unknown>(
    editorBeforeDiscard.draftLedgers[CONFIG_DRAFT_TAB.id],
  )
  const chapterLedger = parseChapterCardDraftLedger(
    editorBeforeDiscard.draftLedgers[CHAPTER_CARD_TAB_ID],
  )

  const currentProjectSession = projectSessionContextFromProject(
    useProjectStore.getState().currentProject,
  )
  if (currentProjectSession) {
    if (characterLedger.projects.some(project => (
      sameProjectPathKey(project.projectKey, currentProjectSession.projectPath)
    ))) {
      useCharacterStore.getState().discardDraft(
        currentProjectSession.projectPath,
        currentProjectSession,
      )
    }
    if (configLedger.projects.some(project => (
      sameProjectPathKey(project.projectKey, currentProjectSession.projectPath)
    ))) {
      useProjectStore.getState().discardNovelConfigDraft(
        currentProjectSession.projectPath,
        currentProjectSession,
      )
    }
  }

  const editor = useEditorStore.getState()
  editor.setDraftLedger(
    CHARACTER_DRAFT_TAB.id,
    JSON.stringify(createEmptyProjectEditorDraftLedger()),
  )
  editor.setDraftLedger(
    CONFIG_DRAFT_TAB.id,
    JSON.stringify(createEmptyProjectEditorDraftLedger()),
  )
  persistChapterCardDraftLedger(editor, {
    ...chapterLedger,
    projects: [],
  })

  discardDirtyTabs(dirtyTabIds)
}
