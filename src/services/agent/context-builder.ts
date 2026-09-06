/**
 * Agent 智能上下文构建器
 *
 * 采用三级注入策略管理 Token 消耗：
 * - L0 始终注入（~500 token）：项目名称/类型/进度/一句话大纲
 * - L1 编辑器感知（~800 token）：当前打开的 Tab 信息
 * - L2 按需获取：通过 Tool 调用获取详细数据
 *
 * 这是 Agent 理解用户上下文的核心模块。
 */

import { useProjectStore } from '../../stores/project-store'
import { useEditorStore } from '../../stores/editor-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import { useLocaleStore } from '../../stores/locale-store'
import type { AgentMode } from '../../stores/agent-store'
import { toolRegistry, type AgentExecutionContext } from './tool-registry'
import {
  projectSessionContextFromProject,
  sameProjectSessionContext,
} from '../../shared/project-session-context'
import { resolveWritingLanguage, type WritingLanguage } from '../../shared/writing-language'
import { promptLanguageText } from '../prompt-language'
import {
  composePromptSystemRole,
  getBuiltinPromptTemplate,
  renderPrompt,
  resolvePromptTemplate,
} from '../prompt-templates'
import { localizeNovelConfigFacts } from '../../shared/novel-config-localization'

// ===== 上下文构建 =====

/**
 * 构建 Agent 系统提示词（含上下文和 Tool 描述）
 *
 * 这是 Agent 每次对话时的系统提示词入口。
 * 将项目上下文、编辑器状态、可用 Tool 列表整合为一份完整的系统提示。
 */
export async function buildAgentSystemPrompt(
  mode: AgentMode,
  executionContext?: AgentExecutionContext,
): Promise<string> {
  const sections: string[] = []
  const currentProject = useProjectStore.getState().currentProject
  const writingLanguage = executionContext?.writingLanguage
    ?? (currentProject
      ? resolveWritingLanguage(currentProject.novelConfig.writingLanguage)
      : useLocaleStore.getState().locale)
  const canUseProjectTools = executionContext
    ? sameProjectSessionContext(
        executionContext.projectSession,
        projectSessionContextFromProject(currentProject),
      )
    : !!currentProject

  // 1. Agent 身份与行为指导
  sections.push(await buildIdentityPrompt(mode, writingLanguage, executionContext))

  // 2. L0 — 始终注入的项目上下文
  const l0 = buildL0ProjectContext(writingLanguage, executionContext)
  if (l0) sections.push(l0)

  // 3. L1 — 编辑器感知上下文
  const l1 = buildL1EditorContext(writingLanguage, executionContext)
  if (l1) sections.push(l1)

  // 4. Tool 系统提示词
  const toolPrompt = toolRegistry.generateToolPrompt(
    writingLanguage,
    tool => canUseProjectTools
      || tool.source === 'mcp'
      || tool.source === 'skill'
      || tool.name === 'inspect_writing_skill'
      || tool.name === 'install_writing_skill',
  )
  if (toolPrompt) sections.push(toolPrompt)

  return sections.join('\n\n---\n\n')
}

// ===== 内部构建方法 =====

/** Agent 身份提示词 */
async function buildIdentityPrompt(
  mode: AgentMode,
  writingLanguage: WritingLanguage,
  executionContext?: AgentExecutionContext,
): Promise<string> {
  const projectSession = executionContext?.projectSession ?? undefined
  const template = await resolvePromptTemplate('assistant_writing_identity', projectSession, writingLanguage)
    ?? getBuiltinPromptTemplate('assistant_writing_identity', writingLanguage)
  if (!template) throw new Error('Missing assistant writing identity prompt')
  const modeInstruction = writingLanguage === 'en-US'
    ? (mode === 'planning'
        ? 'Planning mode: analyze the request, form a short plan, and carry it out through the available application tools.'
        : 'Fast mode: complete straightforward requests directly and efficiently.')
    : (mode === 'planning'
        ? '当前处于规划模式：先分析需求、形成简短方案，再通过可用的应用工具执行。'
        : '当前处于快速模式：直接、高效地完成清晰直接的请求。')
  return `${composePromptSystemRole(template, writingLanguage)}\n\n${renderPrompt(
    template,
    { mode_instruction: modeInstruction },
    writingLanguage,
  )}`
}

/**
 * L0 — 始终注入的项目上下文
 * 约 300-500 token，每次对话都注入
 */
function buildL0ProjectContext(
  writingLanguage: WritingLanguage,
  executionContext?: AgentExecutionContext,
): string | null {
  const project = useProjectStore.getState().currentProject
  if (
    !project
    || (executionContext && !sameProjectSessionContext(
      executionContext.projectSession,
      projectSessionContextFromProject(project),
    ))
  ) return null

  const cfg = project.novelConfig
  const modelFacts = localizeNovelConfigFacts(cfg, writingLanguage)
  const label = (zhCN: string, enUS: string) => promptLanguageText(writingLanguage, zhCN, enUS)
  const parts: string[] = [
    `## ${label('当前项目上下文', 'Current project context')}`,
    `${label('项目名称', 'Project name')}: ${project.name}`,
  ]

  if (modelFacts.genre) {
    parts.push(`${label('类型', 'Genre')}: ${modelFacts.genre}${cfg.subGenre ? ' · ' + cfg.subGenre : ''}`)
  }
  if (modelFacts.targetAudience) {
    parts.push(`${label('目标读者', 'Target readers')}: ${modelFacts.targetAudience}`)
  }
  if (cfg.totalChapters) {
    parts.push(`${label('计划章节数', 'Planned chapters')}: ${cfg.totalChapters}`)
  }
  if (cfg.wordsPerChapter) {
    parts.push(`${label('每章目标字数', 'Target words per chapter')}: ${cfg.wordsPerChapter}`)
  }
  if (modelFacts.narrativePOV) {
    parts.push(`${label('叙事视角', 'Point of view')}: ${modelFacts.narrativePOV}`)
  }
  if (cfg.coreOutline) {
    // 截取前 300 字符，避免 Token 爆炸
    const outline = cfg.coreOutline.length > 300
      ? cfg.coreOutline.slice(0, 300) + label('…', '...')
      : cfg.coreOutline
    parts.push(`${label('核心大纲', 'Core outline')}: ${outline}`)
  }
  if (cfg.writingStyle) {
    const style = cfg.writingStyle.length > 150
      ? cfg.writingStyle.slice(0, 150) + label('…', '...')
      : cfg.writingStyle
    parts.push(`${label('写作风格', 'Writing style')}: ${style}`)
  }

  return parts.join('\n')
}

/**
 * L1 — 编辑器感知上下文
 * 约 200-500 token，注入当前打开的 Tab 信息和工作流状态
 */
function buildL1EditorContext(
  writingLanguage: WritingLanguage,
  executionContext?: AgentExecutionContext,
): string | null {
  const parts: string[] = []
  const label = (zhCN: string, enUS: string) => promptLanguageText(writingLanguage, zhCN, enUS)

  // 当前打开的编辑器 Tab
  const editorState = useEditorStore.getState()
  const currentProject = useProjectStore.getState().currentProject
  if (
    executionContext
    && !sameProjectSessionContext(
      executionContext.projectSession,
      projectSessionContextFromProject(currentProject),
    )
  ) return null
  const currentProjectPath = currentProject?.path
  const projectTabs = currentProjectPath
    ? editorState.tabs.filter(tab => tab.projectKey === currentProjectPath)
    : []
  if (projectTabs.length > 0) {
    const activeTab = projectTabs.find(t => t.id === editorState.activeTabId)
    const tabSummaries = projectTabs.map(t => {
      const active = t.id === editorState.activeTabId ? ` [${label('当前活跃', 'active')}]` : ''
      const dirty = t.dirty ? ` [${label('未保存', 'unsaved')}]` : ''
      return `  - ${t.name} (${t.type})${active}${dirty}`
    }).join('\n')

    parts.push(`## ${label('编辑器状态', 'Editor state')}\n${label('打开的文件', 'Open files')}:\n${tabSummaries}`)

    // 如果当前活跃 Tab 有内容且不太长，注入内容摘要
    if (activeTab?.content && activeTab.content.length > 0) {
      const preview = activeTab.content.length > 500
        ? activeTab.content.slice(0, 500) + `\n${label('…（内容过长已截断，可通过 read_file 工具获取完整内容）', '... (preview truncated; use read_file to retrieve the complete content)')}`
        : activeTab.content
      parts.push(`### ${label('当前活跃文件内容', 'Active file content')}\n${label('文件名', 'File')}: ${activeTab.name}\n\`\`\`\n${preview}\n\`\`\``)
    }
  }

  // 当前工作流状态
  const workflowState = useWorkflowStore.getState()
  if (workflowState.hasActiveRun()) {
    const run = workflowState.activeRuns.find(item => item.projectPath === currentProjectPath)
    if (run) {
      const runName = writingLanguage === 'en-US' ? run.type : run.title
      parts.push(`## ${label('工作流状态', 'Workflow status')}\n${label('正在运行', 'Running')}: ${runName} (${label('进度', 'progress')}: ${run.currentStepIndex + 1}/${run.steps.length})`)
    }
  }

  return parts.length > 0 ? parts.join('\n\n') : null
}
