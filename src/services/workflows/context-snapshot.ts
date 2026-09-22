import type { ContextSnapshot, ProjectEpoch } from '../../shared/source-ref'
import { hashAuthorText } from '../../shared/source-ref'
import type { SelectedMaterial, SourceSelection } from './source-selection'

/** 估计器版本随快照冻结；单位是包含材料的 UTF-8 字节数。 */
export const CONTEXT_ESTIMATOR_VERSION = 'utf8-bytes-v1'

export interface ChapterContextSnapshotInput {
  current: ProjectEpoch
  selection: Extract<SourceSelection, { decision: 'ready' }>
}

/** 码元比较：不用 localeCompare，避免排序依赖 ICU/locale 或把不同字符串判成相等。 */
function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * S01 的槽位只有三种，比类别粗，所以类别另写在 reason 前缀里（`<category>: ...`），
 * 下游必须按 reason 前缀取类别，slot 只作粗归类。
 *
 * `derived-locator` 映射成 `finalized-fact`：stale 定位唯一能进入 included 的东西
 * 是从同一可读定稿回读到的原文，那已是定稿事实，不是「未确认衔接」。
 * `future-plan` 与 `reference` 只作规划性约束，不构成事实。
 */
const SLOT_BY_CATEGORY = {
  author: 'author-constraint',
  'finalized-history': 'finalized-fact',
  'future-plan': 'author-constraint',
  'derived-locator': 'finalized-fact',
  reference: 'author-constraint',
} as const

export function contextSnapshotUnits(entries: readonly SelectedMaterial[]): number {
  return entries.reduce((sum, entry) => sum + new TextEncoder().encode(entry.text).length, 0)
}

/**
 * 冻结选择结果 -> 可重放快照。
 *
 * 指纹覆盖真正进入上下文的内容与完整的省略裁决，所以「同一 ref、不同正文」或
 * 「同一来源集、不同省略」都不会撞成同一个 id。会话 epoch 只记不哈希：同一章
 * 跨会话重放得到同一个快照 id。
 *
 * 边界：S01 的 `ContextSnapshot` 是被冻结的共享 DTO，只承载投影结果。必需的
 * coverage、decision 以及候选 state/lineage 留在调用方的 `SourceSelection` 上，
 * 由 S10B 的 receipt 与快照一起持久化，本函数不扩展共享类型。
 *
 * 本函数不读数据库、不写文件、不发请求。
 */
export async function buildChapterContextSnapshot(input: ChapterContextSnapshotInput): Promise<ContextSnapshot> {
  const ordered = [...input.selection.included].sort((left, right) =>
    compareCodeUnit(left.ref.sourceId, right.ref.sourceId)
    || compareCodeUnit(left.ref.contentHash, right.ref.contentHash)
    || compareCodeUnit(left.text, right.text))
  const omissions = [...input.selection.omissions].sort((left, right) =>
    compareCodeUnit(left.sourceId, right.sourceId)
    || left.revision - right.revision
    || compareCodeUnit(left.contentHash, right.contentHash)
    || compareCodeUnit(left.reason, right.reason)
    || Number(left.required) - Number(right.required))
  const hash = await hashAuthorText(JSON.stringify({
    included: ordered.map(entry => ({
      sourceId: entry.ref.sourceId,
      revision: entry.ref.revision,
      contentHash: entry.ref.contentHash,
      category: entry.category,
      required: entry.required,
      text: entry.text,
    })),
    omissions: omissions.map(omission => ({
      sourceId: omission.sourceId,
      revision: omission.revision,
      contentHash: omission.contentHash,
      reason: omission.reason,
      required: omission.required,
    })),
  }))
  return {
    projectId: input.current.projectId,
    epoch: input.current.epoch,
    id: `context:${hash}`,
    hash,
    sources: ordered.map(entry => ({
      ref: entry.ref,
      slot: SLOT_BY_CATEGORY[entry.category],
      reason: `${entry.category}: ${entry.reason}`,
    })),
    omissions: omissions.map(omission => ({
      sourceId: omission.sourceId,
      reason: omission.reason,
      required: omission.required,
    })),
    estimate: { methodVersion: CONTEXT_ESTIMATOR_VERSION, inputUnits: contextSnapshotUnits(ordered) },
  }
}
