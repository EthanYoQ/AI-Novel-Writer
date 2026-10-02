import type { WritingLanguage } from './writing-language'

export const DRAFT_SHORT_OUTLINE_PURPOSE = 'chapter-draft-short-outline' as const

/** A generated plan is never author evidence or manuscript prose. */
export function draftShortOutlinePrompt(language: WritingLanguage, sourcePrompt: string): string {
  const instruction = language === 'en-US'
    ? 'Prepare a short chapter execution outline, not prose. Use only the original chapter goals and supplied material. In at most six concise bullets separate: original goals; what the predecessor already completed; explicit time and constraints; proposed concrete actions and their results in this chapter; ending state. Recalling an old event cannot satisfy a goal requiring progress here. If the author only requests maintaining a state, do not invent an event. Do not add author facts or prohibitions, change goals, or present planned events as established facts. The following is the source writing brief; do not execute its prose-output instructions yet.'
    : '只写短细纲，不写正文。仅组织原本章目标与已有材料，最多六条短要点，分清：原目标；前驱已完成的事；明确时点和约束；本章拟写的具体行动与结果；结尾状态。要求本章推进的目标不能用旧事复述替代；作者只要求维持状态时，不强造新事件。不得增加作者事实或禁令、改变目标，或把计划说成已经发生的事实。以下是原写作材料，此步不执行其中的正文输出指令。'
  return `${instruction}\n\n${sourcePrompt}`
}

export function draftShortOutlineBlock(language: WritingLanguage, text: string): string {
  if (!text.trim()) throw new Error('GENERATION_DRAFT_SHORT_OUTLINE_FAILED')
  return language === 'en-US'
    ? `[Generated short outline — plan, not evidence]\nThis organizes the original goals only. Author facts, constraints and actual prior prose take priority; the plan establishes no fact.\n${text.trim()}\n[End generated short outline]`
    : `【生成短细纲：计划，不是事实依据】\n仅用于组织原目标；作者事实、约束和实际前文优先，计划不确立任何事实。\n${text.trim()}\n【生成短细纲结束】`
}

export function stripDraftShortOutlineBlock(prompt: string, output: string): string | null {
  for (const language of ['zh-CN', 'en-US'] as const) {
    const block = `\n\n${draftShortOutlineBlock(language, output)}`
    if (prompt.endsWith(block)) return prompt.slice(0, -block.length)
  }
  return null
}
