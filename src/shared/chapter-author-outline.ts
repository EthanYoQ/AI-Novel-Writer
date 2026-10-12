import type { WritingLanguage } from './writing-language'

/** 作者撰写的章节大纲是作者事实与要求，不是生成计划。 */
export function chapterAuthorOutlineBlock(language: WritingLanguage, text: string): string {
    if (!text.trim()) throw new Error('GENERATION_CHAPTER_AUTHOR_OUTLINE_EMPTY')
    return language === 'en-US'
        ? `[Author chapter outline — author facts and requirements]\nAdvance this chapter according to the outline below. Where it conflicts with inferred plans or material summaries, the outline wins; it does not override actual prior prose or explicit author prohibitions elsewhere.\n${text.trim()}\n[End author chapter outline]`
        : `【作者章节大纲：作者事实与要求】\n按以下大纲推进本章。与推断计划或材料摘要冲突时以大纲为准；但不推翻实际前文与其他明确的作者禁令。\n${text.trim()}\n【作者章节大纲结束】`
}
