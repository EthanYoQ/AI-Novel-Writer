import { composeVisibleContinuation } from './visible-continuation'

export const DRAFT_VISIBLE_TEXT_VERSION = 'draft-visible-v2' as const
export type DraftVisibleTextVersion = 'draft-visible-v1' | typeof DRAFT_VISIBLE_TEXT_VERSION
export function isDraftVisibleTextVersion(value: unknown): value is DraftVisibleTextVersion {
  return value === 'draft-visible-v1' || value === DRAFT_VISIBLE_TEXT_VERSION
}
/** 超长正文唯一一次压缩修订的尝试用途；主进程组合时以其全文替换此前正文。 */
export const DRAFT_CONDENSE_PURPOSE = 'chapter-draft-condense' as const

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

export function sanitizeDraftText(text: string, version: DraftVisibleTextVersion = DRAFT_VISIBLE_TEXT_VERSION): string {
  const cleaned = stripDraftThinkingTags(text)
    .replace(/^\s*(?:点我继续生成后续内容|继续生成后续内容|请点击继续|未完待续)\s*$/gmi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  const paragraphs = cleaned.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
  if (version !== 'draft-visible-v1') return paragraphs.join('\n\n')
  // Existing v1 receipts must retain their exact projection and hash on recovery.
  const seen = new Set<string>()
  return paragraphs.filter(paragraph => {
    const key = paragraph.replace(/\s+/g, '')
    if (key.length >= 40 && seen.has(key)) return false
    if (key.length >= 40) seen.add(key)
    return true
  }).join('\n\n')
}

/** Pure projection of independent raw-visible artifacts; source artifacts stay unchanged. */
export function composeDraftVisibleContinuation(existing: string, addition: string,
  version: DraftVisibleTextVersion = DRAFT_VISIBLE_TEXT_VERSION): string {
  return sanitizeDraftText(composeVisibleContinuation(sanitizeDraftText(existing, version), sanitizeDraftText(addition, version)), version)
}
