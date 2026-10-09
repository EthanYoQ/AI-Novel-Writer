import { getBuiltinPromptTemplate, getPromptVariableDescription, pruneEmptyOptionalPromptSections, type PromptTemplate } from '../services/builtin-prompt-templates'
import type { WritingLanguage } from './writing-language'

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
