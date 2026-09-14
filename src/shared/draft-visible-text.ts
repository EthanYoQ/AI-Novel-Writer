import { composeVisibleContinuation } from './visible-continuation'

export const DRAFT_VISIBLE_TEXT_VERSION = 'draft-visible-v1' as const

export function stripDraftThinkingTags(text: string): string {
  if (!text) return text
  // 支持只有 <think> 没有闭合标签的情况。
  const withoutPairedThinking = text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
  const orphanClosingTag = /<\/think>/i.exec(withoutPairedThinking)
  if (!orphanClosingTag || orphanClosingTag.index === undefined) {
    return withoutPairedThinking.replace(/<\/?think>/gi, '').trim()
  }

  const hiddenPrefix = withoutPairedThinking.slice(0, orphanClosingTag.index)
  const visibleSuffix = withoutPairedThinking.slice(orphanClosingTag.index + orphanClosingTag[0].length)
  // A missing opening tag is only safe to treat as hidden reasoning when its
  // prefix identifies itself as reasoning, or when it precedes structured
  // output. Otherwise retain ordinary prose and remove only the malformed tag.
  const looksLikeReasoning = /^\s*(?:思考|推理|分析|reasoning|analysis)/iu.test(hiddenPrefix)
  const hasStructuredVisibleSuffix = /^\s*(?:```(?:json)?\s*)?[{[]/iu.test(visibleSuffix)
  const cleaned = looksLikeReasoning || hasStructuredVisibleSuffix
    ? visibleSuffix
    : `${hiddenPrefix}${visibleSuffix}`
  return cleaned.replace(/<\/?think>/gi, '').trim()
}

export function sanitizeDraftText(text: string): string {
  const cleaned = stripDraftThinkingTags(text)
    .replace(/^\s*(?:点我继续生成后续内容|继续生成后续内容|请点击继续|未完待续)\s*$/gmi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  const paragraphs = cleaned.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
  const seen = new Set<string>()
  const deduped: string[] = []
  for (const paragraph of paragraphs) {
    const key = paragraph.replace(/\s+/g, '')
    if (key.length >= 40 && seen.has(key)) continue
    if (key.length >= 40) seen.add(key)
    deduped.push(paragraph)
  }
  return deduped.join('\n\n').trim()
}

/** Pure projection of independent raw-visible artifacts; source artifacts stay unchanged. */
export function composeDraftVisibleContinuation(existing: string, addition: string): string {
  return sanitizeDraftText(composeVisibleContinuation(sanitizeDraftText(existing), sanitizeDraftText(addition)))
}
