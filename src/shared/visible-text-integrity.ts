import { localize } from '../i18n/core'
import type { Locale } from '../i18n/types'

export const ZH_CN_TRUNCATION_MARKER = '\n…[内容已按上下文预算截断]…\n'
export const EN_US_TRUNCATION_MARKER = '\n…[content truncated to fit the context budget]…\n'
const MAX_META_OPENING_VISIBLE_UNITS = 200
const MIN_OBVIOUS_DUPLICATE_PARAGRAPH_VISIBLE_UNITS = 120

export function visibleProseUnitCount(text: string): number {
  return text.match(/[\p{L}\p{N}]/gu)?.length ?? 0
}

function mechanicalCompletionError(uiLocale: Locale, zhCNReason: string, enUSReason: string): Error {
  return new Error(localize(
    uiLocale,
    `AI 输出包含${zhCNReason}，可能仍不完整，结果未被保存。`,
    `AI output contains ${enUSReason} and may still be incomplete, so it was not saved.`,
  ))
}

/**
 * The single mechanical-integrity gate for AI-produced visible prose. A `stop`
 * finish reason does not prove the text passed it, so every path that accepts
 * such text (first execution, recovery resume, main-process commit) shares it.
 */
export function assertMechanicallyCompleteVisibleText(content: string, uiLocale: Locale): void {
  const trimmed = content.trim()
  if (visibleProseUnitCount(trimmed) === 0) {
    throw mechanicalCompletionError(uiLocale, '空白或无可见正文', 'blank or no visible prose')
  }
  if (/(?:^|\n)\s*```/u.test(trimmed)) {
    throw mechanicalCompletionError(uiLocale, '代码围栏', 'a code fence')
  }
  if (/<\/?\s*think(?:\s|>|$)/iu.test(trimmed)) {
    throw mechanicalCompletionError(uiLocale, 'think 标签残片', 'a leftover think tag')
  }

  const paragraphs = trimmed
    .split(/\n\s*\n+/u)
    .map(paragraph => paragraph.trim())
    .filter(Boolean)
  const opening = trimmed.split(/\r?\n/u).map(line => line.trim()).find(Boolean) ?? ''
  if (
    visibleProseUnitCount(opening) <= MAX_META_OPENING_VISIBLE_UNITS
    && (
      /^(?:以下|下面)(?:是|为)(?:(?:根据|按照)(?:您|用户)(?:的)?(?:要求|指示))?(?:(?:修订|修改|重写|生成|完成|提供)(?:后)?的?)?(?:完整的?)?(?:正文|章节(?:正文)?|内容)\s*(?:[：:]|[。.!！]?$)/u.test(opening)
      || /^(?:certainly[,!:]?\s+)?(?:here|below)\s+is\s+(?:(?:the|your)\s+)?(?:(?:revised|rewritten|generated|complete|full|updated|requested)\s+)*(?:text|chapter|content|revision|version|draft|prose)\s*(?:[:：]|[.!]?$)/iu.test(opening)
      || /^(?:(?:根据|按照)(?:您|用户).{0,40}(?:要求|指示)|这是(?:我为您|根据您的要求).{0,30}(?:修订|修改|重写|生成)|as\s+requested|certainly[,!:]?\s+i(?:'ve|\s+have)|i\s+(?:have\s+(?:revised|rewritten|generated)|will\s+(?:provide|write|revise))\b)/iu.test(opening)
    )
  ) {
    throw mechanicalCompletionError(uiLocale, '首段元话术', 'opening meta commentary')
  }

  if (
    trimmed.includes(ZH_CN_TRUNCATION_MARKER.trim())
    || trimmed.includes(EN_US_TRUNCATION_MARKER.trim())
    || paragraphs.some(paragraph => /^(?:…\s*)?(?:\[(?:内容已按上下文预算截断|内容截断|输出被截断|content truncated to fit the context budget|truncated)\]|[（(]?(?:未完待续|未完)[）)]?)(?:\s*…)?$/iu.test(paragraph))
  ) {
    throw mechanicalCompletionError(uiLocale, '截断标记', 'a truncation marker')
  }

  const duplicateCandidateGroups = [
    paragraphs,
    trimmed.split(/\r?\n/u).map(line => line.trim()).filter(Boolean),
  ]
  for (const candidates of duplicateCandidateGroups) {
    const seenParagraphs = new Set<string>()
    for (const paragraph of candidates) {
      const normalized = paragraph.replace(/\s+/gu, ' ').trim()
      if (visibleProseUnitCount(normalized) < MIN_OBVIOUS_DUPLICATE_PARAGRAPH_VISIBLE_UNITS) continue
      if (seenParagraphs.has(normalized)) {
        throw mechanicalCompletionError(uiLocale, '明显重复段落', 'an obviously duplicated paragraph')
      }
      seenParagraphs.add(normalized)
    }
  }
}
