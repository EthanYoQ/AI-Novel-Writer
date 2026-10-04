import { writingLanguageText as promptLanguageText, type WritingLanguage } from './writing-language'

export function buildStructuredReplacementPrompt(
  originalPrompt: string,
  visiblePartial: string,
  writingLanguage: WritingLanguage,
): string {
  return promptLanguageText(
    writingLanguage,
    `上一轮结构化输出因长度限制而中断。请重新完成任务。\n\n`
      + `【原始任务】\n${originalPrompt}\n\n`
      + `【上一轮可见的不完整输出（仅供参考，可能不完整）】\n${visiblePartial || '（没有可用输出）'}\n\n`
      + `【硬性要求】\n`
      + `- 返回完整 JSON，从头重建，不要只补后缀。\n`
      + `- 仅输出可被 JSON.parse 解析的完整 JSON；不要 Markdown、解释或思考过程。\n`
      + `- 以上一轮可见内容为参考，但以原始任务为准，补全所有必需字段和数组。`,
    `The previous structured output stopped at the length limit. Complete the task again.\n\n`
      + `[Original task]\n${originalPrompt}\n\n`
      + `[Visible incomplete output from the previous attempt — reference only]\n${visiblePartial || '(no visible output)'}\n\n`
      + `[Requirements]\n`
      + `- Rebuild and return the complete JSON from the beginning; do not return only a suffix.\n`
      + `- Output only complete JSON accepted by JSON.parse, with no Markdown, explanation, or reasoning.\n`
      + `- Use the visible prior output only as evidence; the original task remains authoritative, and every required field and array must be complete.`,
  )
}
