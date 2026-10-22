import { ipc } from './ipc-client'
import { useCharacterStore } from '../stores/character-store'
import { useDraftStore } from '../stores/draft-store'
import { useEditorStore, type EditorTab } from '../stores/editor-store'
import { useProjectStore } from '../stores/project-store'
import { useWorkflowStore } from '../stores/workflow-store'
import { useLocaleStore } from '../stores/locale-store'
import { knownAppErrorMessage } from '../i18n/app-errors'
import type { ProjectClearScope, ProjectSessionContext } from '../shared/ipc-channels'
import {
  getActiveProjectSessionContext,
  sameProjectSessionContext,
} from '../shared/project-session-context'

export interface ClearProjectDataOptions {
  creativeFields?: boolean
  blueprints?: boolean
  generatedText?: boolean
}

export interface ClearProjectDataResult {
  cleared: ProjectClearScope[]
}

const AFFECTED_TAB_TYPES: Record<ProjectClearScope, EditorTab['type'][]> = {
  creativeFields: ['config', 'world-building', 'arch-file', 'character'],
  blueprints: ['chapter-card'],
  generatedText: ['chapter', 'diff', 'version-history', 'review-report'],
}

const AFFECTED_DRAFT_LEDGERS: Partial<Record<
  string,
  { scope: ProjectClearScope; label: readonly [zhCN: string, enUS: string] }
>> = {
  config: { scope: 'creativeFields', label: ['小说配置', 'Novel settings'] },
  'character-editor-drafts': { scope: 'creativeFields', label: ['角色卡', 'Character cards'] },
  'chapter-card-editor': { scope: 'blueprints', label: ['章节蓝图', 'Chapter blueprints'] },
}

function isProjectSessionCurrent(projectSession: ProjectSessionContext): boolean {
  return sameProjectSessionContext(projectSession, getActiveProjectSessionContext())
}

function assertProjectSessionCurrent(projectSession: ProjectSessionContext): void {
  if (!isProjectSessionCurrent(projectSession)) {
    throw new Error(useLocaleStore.getState().text('项目会话已变化，本次清除已取消', 'The book session changed, so clearing was cancelled.'))
  }
}

function normalizeOptions(options: ClearProjectDataOptions): Required<ClearProjectDataOptions> {
  return {
    creativeFields: !!options.creativeFields,
    blueprints: !!options.blueprints,
    generatedText: !!options.generatedText,
  }
}

function selectedScopes(options: Required<ClearProjectDataOptions>): ProjectClearScope[] {
  const scopes: ProjectClearScope[] = []
  if (options.generatedText) scopes.push('generatedText')
  if (options.blueprints) scopes.push('blueprints')
  if (options.creativeFields) scopes.push('creativeFields')
  return scopes
}

function affectedTabs(
  scopes: ProjectClearScope[],
  tabs: EditorTab[],
  projectKey: string,
): EditorTab[] {
  const affectedTypes = new Set(scopes.flatMap(scope => AFFECTED_TAB_TYPES[scope]))
  return tabs.filter(tab => tab.projectKey === projectKey && !tab.planningRecovery && affectedTypes.has(tab.type))
}

function affectedHiddenDraftLabels(
  scopes: ProjectClearScope[],
  draftLedgers: Readonly<Record<string, string>>,
  projectKey: string,
): string[] {
  const selected = new Set(scopes)
  const labels = new Set<string>()
  for (const [ledgerKey, descriptor] of Object.entries(AFFECTED_DRAFT_LEDGERS)) {
    if (!descriptor || !selected.has(descriptor.scope)) continue
    const content = draftLedgers[ledgerKey]
    if (!content) continue
    try {
      const parsed = JSON.parse(content) as {
        version?: unknown
        projects?: Array<{ projectKey?: unknown }>
      }
      if (
        parsed.version === 1
        && Array.isArray(parsed.projects)
        && parsed.projects.some(project => project.projectKey === projectKey)
      ) {
        labels.add(useLocaleStore.getState().text(...descriptor.label))
      }
    } catch {
      // 无法归属到具体项目的损坏账本由原有恢复流程保留，不扩大清理范围。
    }
  }
  return [...labels]
}

function assertResult(result: { success: boolean; error?: string }): void {
  if (!result.success) {
    // 对话框标题已写「清除失败」：中文界面只给主进程原因，英文界面不转出中文原文。
    const { locale, text } = useLocaleStore.getState()
    throw new Error(knownAppErrorMessage(locale, result.error)
      ?? (result.error && locale !== 'en-US' ? result.error : text('清除项目生成内容失败', 'The generated content could not be cleared.')))
  }
}

export async function clearProjectData(
  options: ClearProjectDataOptions,
  projectSession: ProjectSessionContext,
): Promise<ClearProjectDataResult> {
  const normalized = normalizeOptions(options)
  const scopes = selectedScopes(normalized)
  if (scopes.length === 0) return { cleared: [] }

  assertProjectSessionCurrent(projectSession)
  const projectPath = projectSession.projectPath

  if (useWorkflowStore.getState().hasActiveRun()) {
    throw new Error(useLocaleStore.getState().text('当前仍有工作流运行中，请先等待完成或取消工作流后再清除。', 'A workflow is still running. Wait for it to finish or cancel it, then clear.'))
  }

  const editorState = useEditorStore.getState()
  const tabsToClose = affectedTabs(scopes, editorState.tabs, projectPath)
  const dirtyTabs = tabsToClose.filter(tab => tab.dirty)
  const hiddenDraftLabels = affectedHiddenDraftLabels(
    scopes,
    editorState.draftLedgers ?? {},
    projectPath,
  )
  const unsavedLabels = [...new Set([
    ...dirtyTabs.map(tab => tab.name),
    ...hiddenDraftLabels,
  ])]
  if (unsavedLabels.length > 0) {
    throw new Error(useLocaleStore.getState().text(
      `以下内容有未保存修改，请先保存或放弃草稿后再清除：${unsavedLabels.join('、')}`,
      `These items have unsaved changes. Save or discard them before clearing: ${unsavedLabels.join(', ')}`,
    ))
  }

  assertProjectSessionCurrent(projectSession)
  const result = await ipc.invokeWithProjectSession(
    projectSession,
    'db:project-clear-generated-data',
    normalized,
    projectPath,
  )
  if (!isProjectSessionCurrent(projectSession)) {
    return { cleared: result.cleared ?? scopes }
  }
  assertResult(result)

  for (const tab of tabsToClose) {
    editorState.closeTab(tab.id)
  }

  if (normalized.generatedText) {
    useDraftStore.getState().reset()
  }
  if (normalized.creativeFields) {
    await useCharacterStore.getState().load(projectPath, projectSession)
  }

  assertProjectSessionCurrent(projectSession)
  await useProjectStore.getState().refreshFileTree(projectPath, undefined, projectSession)
  if (!isProjectSessionCurrent(projectSession)) return { cleared: result.cleared ?? scopes }

  return { cleared: result.cleared ?? scopes }
}
