import { ipc } from './ipc-client'
import { useDraftStore } from '../stores/draft-store'
import { useEditorStore, type EditorTab } from '../stores/editor-store'
import { useProjectStore } from '../stores/project-store'
import { useWorkflowStore } from '../stores/workflow-store'
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
  creativeFields: ['config', 'world-building', 'arch-file'],
  blueprints: ['chapter-card'],
  generatedText: ['chapter', 'diff', 'version-history', 'review-report'],
}

const AFFECTED_DRAFT_LEDGERS: Partial<Record<
  string,
  { scope: ProjectClearScope; label: string }
>> = {
  config: { scope: 'creativeFields', label: '小说配置' },
  'chapter-card-editor': { scope: 'blueprints', label: '章节蓝图' },
}

const PROJECT_SESSION_CHANGED_ERROR = '项目会话已变化，本次清除已取消'

function isProjectSessionCurrent(projectSession: ProjectSessionContext): boolean {
  return sameProjectSessionContext(projectSession, getActiveProjectSessionContext())
}

function assertProjectSessionCurrent(projectSession: ProjectSessionContext): void {
  if (!isProjectSessionCurrent(projectSession)) {
    throw new Error(PROJECT_SESSION_CHANGED_ERROR)
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
  return tabs.filter(tab => tab.projectKey === projectKey && affectedTypes.has(tab.type))
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
        labels.add(descriptor.label)
      }
    } catch {
      // 无法归属到具体项目的损坏账本由原有恢复流程保留，不扩大清理范围。
    }
  }
  return [...labels]
}

function assertResult(result: { success: boolean; error?: string }, label: string): void {
  if (!result.success) {
    throw new Error(result.error || `${label}失败`)
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
    throw new Error('当前仍有工作流运行中，请先等待完成或取消工作流后再清除。')
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
    throw new Error(`以下内容有未保存修改，请先保存或放弃草稿后再清除：${unsavedLabels.join('、')}`)
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
  assertResult(result, '清除项目生成内容')

  for (const tab of tabsToClose) {
    editorState.closeTab(tab.id)
  }

  if (normalized.generatedText) {
    useDraftStore.getState().reset()
  }

  assertProjectSessionCurrent(projectSession)
  await useProjectStore.getState().refreshFileTree(projectPath, undefined, projectSession)
  if (!isProjectSessionCurrent(projectSession)) return { cleared: result.cleared ?? scopes }

  return { cleared: result.cleared ?? scopes }
}
