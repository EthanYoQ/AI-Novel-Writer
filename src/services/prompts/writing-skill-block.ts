/**
 * 写作 Skill 注入文本 —— **单一来源**。
 *
 * 内置工作流（base-command）把这段前置到发给模型的用户消息最前面；
 * 外部 AI 审计要复制同样的文本给网页版 AI。两处必须是同一段文字，
 * 所以格式收在这里，谁都不许再手写一份。
 *
 * 措辞里那句「作者事实、项目写作语言和后续输出合同始终优先」是刻意的：
 * Skill 只补充创作方法，不能反过来盖过项目自己的输出合同。
 */

import type { WritingLanguage } from '../../shared/writing-language'

export interface WritingSkillBlockSource {
  name: string
  content: string
}

export function formatWritingSkillBlock(
  skill: WritingSkillBlockSource,
  writingLanguage: WritingLanguage,
): string {
  return writingLanguage === 'en-US'
    ? `[Supplemental writing skill: ${skill.name}]\nThis guidance may improve craft, but author facts, the project writing language, and the output contract below always take priority.\n${skill.content}`
    : `【补充写作 Skill：${skill.name}】\n以下内容只能补充创作方法；作者事实、项目写作语言和后续输出合同始终优先。\n${skill.content}`
}
