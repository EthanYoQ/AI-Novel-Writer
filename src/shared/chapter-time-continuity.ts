import { writingLanguageText, type WritingLanguage } from './writing-language'

/** Keep the established drafting contract byte-for-byte across its consumers. */
export function chapterTimeContinuity(language: WritingLanguage): string {
  return writingLanguageText(language,
    "【时间承接】本章紧接上一章结尾：作者没有写明跨日或时间间隔时，视为同一天内的紧接发展，上一章事件就发生在不久之前，不得写成“昨天”“昨夜”“前一天”。已定稿事件的时点以定稿原文和【本章写作方向】里的时点说明为准，本章提到这些事件时须按该时点换算（例如定稿写“黄昏”、本章时点为“同日深夜”，则那些事件发生在“黄昏时”“傍晚那会儿”；定稿写“傍晚”、本章时点为“次日上午”，则写“昨晚”“昨天傍晚”）。",
    "[Time continuity] This chapter follows directly on the previous chapter's ending: when the author states no day change or time gap, treat it as a continuation within the same day; events of the previous chapter happened a little while ago and must not be written as \"yesterday\", \"last night\", or \"the day before\". The time of finalized events is fixed by the finalized text and by the time stated in [Chapter brief]; when this chapter mentions those events, convert their time accordingly (for example, if the finalized text says \"dusk\" and this chapter is \"late the same night\", those events happened \"at dusk\" or \"earlier this evening\"; if it says \"evening\" and this chapter is \"the next morning\", write \"last night\" or \"yesterday evening\").")
}

export function reviewTimeContinuity(language: WritingLanguage): string {
  return [chapterTimeContinuity(language), writingLanguageText(language,
    '【审修时间归属】正文自身明确写出的跨日或时间间隔优先于同日默认；只有作者和正文都没有交代跨日或间隔时，才按同日紧接换算。仍须核对正文是否违反作者明确时点。前驱中没有自带时点的动作，按叙事顺序归属到它前面最近的明确时点，不得借用更早段落的时点。仍无法确定时，采用不新增具体时点的表述并保留不确定性。AI 建议中的具体时点不构成来源依据。',
    '[Time attribution for review and revision] An explicit day change or time gap in the manuscript takes priority over the same-day default; use the same-day continuation only when neither author nor manuscript states a day change or gap. Still check for conflicts with explicit author timing. Attribute a predecessor action without its own time to the nearest preceding explicit time in narrative order, never to a time borrowed from an earlier paragraph. If uncertain, preserve uncertainty without adding a specific time. A specific time proposed by AI is not source evidence.')].join('\n\n')
}
