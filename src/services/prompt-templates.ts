import type { ProjectSessionContext } from '../shared/ipc-channels'
import { resolveWritingLanguage, type WritingLanguage } from '../shared/writing-language'
import { getActiveProjectSessionContext } from '../shared/project-session-context'
import { PromptCatalog, ipcPromptPersistence } from './prompt-catalog'
import { BUILTIN_PROMPTS, getBuiltinPromptTemplate, getPromptVariableDescription, pruneEmptyOptionalPromptSections, type PromptTemplate } from './builtin-prompt-templates'
export * from './builtin-prompt-templates'

/** 提示词生命周期唯一所有者；工作流通过 async resolve 自动完成水合。 */
export const promptCatalog = new PromptCatalog(
  BUILTIN_PROMPTS,
  ipcPromptPersistence,
  getActiveProjectSessionContext,
)

/** 项目关闭、切换或新加载开始时立即失效，绝不沿用旧 lease 的覆盖。 */
export function clearProjectCustomPrompts(): void {
  promptCatalog.clearProject()
}

/** 加载全局自定义 Prompt 覆盖（从 ~/.vela/prompts/ 目录） */
export async function loadCustomPrompts(writingLanguage: WritingLanguage = 'zh-CN'): Promise<void> {
  await promptCatalog.list(undefined, writingLanguage)
}

/** 加载项目级自定义 Prompt 覆盖（从 {projectPath}/.vela/prompts/ 目录） */
export async function loadProjectCustomPrompts(
  projectSession: ProjectSessionContext,
  writingLanguage: WritingLanguage = 'zh-CN',
): Promise<boolean> {
  return promptCatalog.loadProject(projectSession, writingLanguage)
}

/** 根据 key 获取 Prompt 模板（三级优先级：当前 session 项目级 > 全局级 > 内置） */
export function getPromptTemplate(
  key: string,
  projectSession?: ProjectSessionContext,
  writingLanguage: WritingLanguage = 'zh-CN',
): PromptTemplate | undefined {
  const resolved = promptCatalog.peek(key, projectSession, resolveWritingLanguage(writingLanguage))
  if (!resolved || resolved.source === 'builtin') return getBuiltinPromptTemplate(key, writingLanguage)
  return resolved.template
}

/** 工作流读取入口：首次调用会自动等待全局与当前项目覆盖水合。 */
export async function resolvePromptTemplate(
  key: string,
  projectSession: ProjectSessionContext | undefined,
  writingLanguage: WritingLanguage,
): Promise<PromptTemplate | undefined> {
  const language = resolveWritingLanguage(writingLanguage)
  const resolved = await promptCatalog.resolve(key, projectSession, language)
  if (!resolved) return undefined
  return resolved.source === 'builtin'
    ? getBuiltinPromptTemplate(key, writingLanguage)
    : resolved.template
}

/** 获取指定模板当前生效的来源 */
export function getPromptSource(
  key: string,
  projectSession?: ProjectSessionContext,
  writingLanguage: WritingLanguage = 'zh-CN',
): 'builtin' | 'global' | 'project' {
  return promptCatalog.peek(key, projectSession, resolveWritingLanguage(writingLanguage))?.source ?? 'builtin'
}

/** 获取所有模板（合并自定义，保留三级覆盖优先级） */
export function getAllPromptTemplates(
  projectSession?: ProjectSessionContext,
  writingLanguage: WritingLanguage = 'zh-CN',
): PromptTemplate[] {
  return BUILTIN_PROMPTS.map((template) => (
    getPromptTemplate(template.key, projectSession, writingLanguage) ?? template
  ))
}

/** 保存全局自定义 Prompt 到 ~/.vela/prompts/ */
export async function saveCustomPrompt(template: PromptTemplate): Promise<boolean> {
  return promptCatalog.commit({ action: 'save', scope: 'global', template })
}

/** 保存项目级自定义 Prompt 到 {projectPath}/.vela/prompts/ */
export async function saveProjectCustomPrompt(
  projectSession: ProjectSessionContext,
  template: PromptTemplate,
): Promise<boolean> {
  return promptCatalog.commit({ action: 'save', scope: 'project', projectSession, template })
}

/** 删除全局自定义 Prompt（恢复为内置版本） */
export async function deleteCustomPrompt(
  key: string,
  writingLanguage: WritingLanguage = 'zh-CN',
): Promise<boolean> {
  return promptCatalog.commit({ action: 'delete', scope: 'global', key, writingLanguage })
}

/** 删除项目级自定义 Prompt（恢复为全局/内置版本） */
export async function deleteProjectCustomPrompt(
  projectSession: ProjectSessionContext,
  key: string,
  writingLanguage: WritingLanguage = 'zh-CN',
): Promise<boolean> {
  return promptCatalog.commit({ action: 'delete', scope: 'project', projectSession, key, writingLanguage })
}

/** Appends only authoritative values that a custom prompt body omitted. */
export function appendRequiredPromptContext(
  content: string,
  template: PromptTemplate,
  variables: Record<string, string>,
  writingLanguage: WritingLanguage,
): string {
  const builtinTemplate = getBuiltinPromptTemplate(template.key, writingLanguage)
  const referencedSources = [
    template.content,
    template.taskGuidance ?? '',
    builtinTemplate?.systemSuffix ?? '',
  ]
  const requiredContext = (builtinTemplate?.requiredContextVariables ?? [])
    .filter(key => !referencedSources.some(source => source.includes(`{{${key}}}`)))
    .flatMap((key) => {
      const value = variables[key]?.trim()
      if (!value || !builtinTemplate) return []
      return [`${getPromptVariableDescription(builtinTemplate, key, writingLanguage)}:\n${value}`]
    })
  if (requiredContext.length === 0) return content
  const heading = writingLanguage === 'en-US'
    ? '[Authoritative project context omitted by the custom template — must still be followed]'
    : '【自定义模板未引用但仍必须遵循的权威项目设定】'
  return `${content}\n\n${heading}\n${requiredContext.join('\n\n')}`
}

/** Render only the editable creative guidance, without the template body or hidden output suffix. */
export function renderPromptTaskGuidance(
  template: Pick<PromptTemplate, 'taskGuidance'>,
  variables: Record<string, string>,
  writingLanguage: WritingLanguage,
): string {
  if (!template.taskGuidance?.trim()) return ''
  let guidance = template.taskGuidance
  for (const [key, value] of Object.entries(variables)) {
    guidance = guidance.replaceAll(`{{${key}}}`, value)
  }
  const heading = writingLanguage === 'en-US'
    ? '[User-defined creative guidance]'
    : '【用户自定义创作指导】'
  return `${heading}\n${guidance.trim()}`
}

/** 渲染 Prompt 模板（填充变量 + 自动追加内置 systemSuffix + 空段落裁剪） */
export function renderPrompt(
  template: PromptTemplate,
  variables: Record<string, string>,
  writingLanguage: WritingLanguage,
): string {
  let content = template.content
  for (const [key, value] of Object.entries(variables)) {
    content = content.replaceAll(`{{${key}}}`, value)
  }

  const taskGuidance = renderPromptTaskGuidance(template, variables, writingLanguage)
  if (taskGuidance) content += `\n\n${taskGuidance}`

  // 自动追加系统约束（始终从内置模板获取，不受用户自定义影响）
  const builtinTemplate = getBuiltinPromptTemplate(template.key, writingLanguage)
  const suffix = builtinTemplate?.systemSuffix
  if (suffix) {
    let renderedSuffix = suffix
    for (const [key, value] of Object.entries(variables)) {
      renderedSuffix = renderedSuffix.replaceAll(`{{${key}}}`, value)
    }
    content = content + '\n\n' + renderedSuffix
  }

  return pruneEmptyOptionalPromptSections(
    appendRequiredPromptContext(content, template, variables, writingLanguage),
  )
}
