import { stripDraftThinkingTags } from './draft-visible-text'
import type { WritingLanguage } from './writing-language'

/**
 * 生成前定稿对账：首稿请求之前的一次模型调用，把已定稿事实（含作者最新更正）与本章蓝图的
 * 必需事件逐条对照，产出冲突清单与“与定稿一致的落实方式”。结果注入首稿提示（执行卡之后）以及
 * 自动续写/压缩修订共用的作者资料块。
 *
 * 渲染层与主进程共用本模块：主进程据此从对账尝试的原始输出重算注入块，复核首稿提示除该块外
 * 与材料准入收据绑定的 promptHash 完全一致，渲染层因此无法借“对账结果”夹带任意内容。
 */
export const DRAFT_RECONCILE_PURPOSE = 'chapter-draft-reconcile' as const

const MAX_ITEMS = 8
const MAX_STATE_CHARS = 300
const MAX_EVENT_CHARS = 200
const MAX_REALIZATION_CHARS = 400

export interface DraftReconciliation {
  finalState: string[]
  events: { event: string; conflict: boolean; realization: string }[]
}

function line(value: unknown, max: number, allowEmpty = false): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(/\s+/gu, ' ').trim()
  if ((!text && !allowEmpty) || text.length > max) return null
  return text
}

/** 严格解析对账输出；任何形状不符都返回 null（调用方按“无对账”继续）。 */
export function parseDraftReconciliation(output: string): DraftReconciliation | null {
  const visible = stripDraftThinkingTags(output ?? '').replace(/^\s*```(?:json)?\s*|\s*```\s*$/giu, '').trim()
  const start = visible.indexOf('{'), end = visible.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let value: unknown
  try { value = JSON.parse(visible.slice(start, end + 1)) } catch { return null }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  // 模型偶尔把 finalState 写成“要点名: 内容”的对象；按原顺序展开为“要点名：内容”。
  const states = record.finalState && typeof record.finalState === 'object' && !Array.isArray(record.finalState)
    ? Object.entries(record.finalState as Record<string, unknown>).map(([key, item]) => typeof item === 'string' ? `${key}：${item}` : null)
    : record.finalState
  if (!Array.isArray(states) || !Array.isArray(record.events)
    || states.length > MAX_ITEMS || record.events.length > MAX_ITEMS
    || states.length + record.events.length === 0) return null
  const finalState: string[] = []
  for (const item of states) {
    const text = line(item, MAX_STATE_CHARS)
    if (text === null) return null
    finalState.push(text)
  }
  const events: DraftReconciliation['events'] = []
  for (const item of record.events) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const entry = item as Record<string, unknown>
    const event = line(entry.event, MAX_EVENT_CHARS)
    const realization = line(entry.realization ?? '', MAX_REALIZATION_CHARS, true)
    if (event === null || realization === null || typeof entry.conflict !== 'boolean'
      || entry.conflict && !realization) return null
    events.push({ event, conflict: entry.conflict, realization })
  }
  return { finalState, events }
}

export function renderDraftReconciliationBlock(writingLanguage: WritingLanguage, value: DraftReconciliation): string {
  const english = writingLanguage === 'en-US'
  const conflicts = value.events.some(item => item.conflict)
  const lines = [english
    ? '[Reconciliation with finalized chapters (automatic pre-draft check; binding)]'
    : '【本章与定稿对账（生成前自动对账，须遵守）】']
  if (value.finalState.length) {
    lines.push(english
      ? 'State at the end of the finalized previous chapter (it holds until this chapter\'s prose shows a condition being met or a character making a new decision):'
      : '上一章定稿结束时的状态（本章正文写出条件满足或人物作出新决定之前保持不变）：')
    lines.push(...value.finalState.map(item => `- ${item}`))
  }
  if (value.events.length) {
    lines.push(english ? 'How to realize this chapter\'s required events:' : '本章必需事件的落实方式：')
    // 不冲突的条目也保留模型给出的具体落实方式：只写“按原文”会让首稿按字面执行仍在等待条件的计划。
    const asWritten = (text: string) => !text || /^(?:按原文(?:落实)?|as written)[。.]?$/iu.test(text)
    lines.push(...value.events.map(item => item.conflict
      ? english ? `- ${item.event} (conflicts with the finalized facts if taken literally): ${item.realization}`
        : `- ${item.event}（按字面会与定稿冲突）：${item.realization}`
      : english ? `- ${item.event}: ${asWritten(item.realization) ? 'as written, without contradicting the state above.' : item.realization}`
        : `- ${item.event}：${asWritten(item.realization) ? '按原文落实，不得与上述状态矛盾。' : item.realization}`))
  }
  lines.push(conflicts
    ? english
      ? 'Conclusion: resolve the conflicts above exactly as stated; never write a withdrawn, cancelled, or superseded plan as executed.'
      : '对账结论：以上冲突按给出的落实方式处理；不得把已撤回、取消或被取代的计划写成已执行。'
    : english
      ? 'Conclusion: the blueprint does not conflict with the finalized facts; follow the state and realizations above, and never write a withdrawn, paused, or still-waiting plan as executed.'
      : '对账结论：蓝图与定稿不冲突；按上述状态与落实方式写，已撤回、暂停或仍在等待条件的计划不得写成已执行。')
  return lines.join('\n')
}

/** 对账原始输出 -> 注入块；输出不可用时返回空串。 */
export function draftReconciliationBlock(writingLanguage: WritingLanguage, output: string): string {
  const parsed = parseDraftReconciliation(output)
  return parsed ? renderDraftReconciliationBlock(writingLanguage, parsed) : ''
}

/**
 * 主进程复核：若 prompt 恰好含一次由 output 渲染出的注入块（前接一个空行），返回移除该块后的
 * 原始提示；否则返回 null。两种写作语言都尝试，块内容完全由对账输出决定。
 */
export function stripDraftReconciliationBlock(prompt: string, output: string): string | null {
  const parsed = parseDraftReconciliation(output)
  if (!parsed) return null
  for (const language of ['zh-CN', 'en-US'] as const) {
    const needle = `\n\n${renderDraftReconciliationBlock(language, parsed)}`
    if (prompt.split(needle).length === 2) return prompt.replace(needle, '')
  }
  return null
}

/** 写稿候选列表只列正文产物：生成前定稿对账的产物是依据而非正文，不作为候选行展示。 */
export function withoutDraftReconciliationArtifacts<T extends { artifactId: string }>(
  artifacts: readonly T[],
  recovery: { draftReconciliation?: { artifactIds: readonly string[] } },
): T[] {
  const excluded = new Set(recovery.draftReconciliation?.artifactIds ?? [])
  return artifacts.filter(artifact => !excluded.has(artifact.artifactId))
}
