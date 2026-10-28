/** 草稿状态：主进程、草稿索引与工作流共用 */
export type DraftStatus = 'draft' | 'revised' | 'reviewed' | 'finalized' | 'superseded' | 'archived'

export interface DraftStatusInfo {
  readOnly: boolean
  label: readonly [zh: string, en: string]
}

export const DRAFT_STATUS_INFO: Readonly<Record<DraftStatus, DraftStatusInfo>> = {
  draft: { readOnly: false, label: ['草稿', 'Draft'] },
  reviewed: { readOnly: false, label: ['草稿', 'Draft'] },
  revised: { readOnly: false, label: ['修稿已合并', 'Revised'] },
  finalized: { readOnly: true, label: ['定稿', 'Final'] },
  superseded: { readOnly: true, label: ['已被替换的定稿', 'Replaced final'] },
  archived: { readOnly: true, label: ['已归档', 'Archived'] },
}

/** 还能继续写、改、审的工作稿状态；旧版本审稿留下的 reviewed 也算（#411）。 */
export const WORKING_DRAFT_STATUSES = ['draft', 'revised', 'reviewed'] as const satisfies readonly DraftStatus[]

export const CURRENT_DRAFT_STATUSES = [...WORKING_DRAFT_STATUSES, 'finalized'] as const satisfies readonly DraftStatus[]

/** CURRENT_DRAFT_STATUSES 的 SQL IN 列表片段，主进程查询「最新一稿」时共用。 */
export const CURRENT_DRAFT_STATUS_SQL = CURRENT_DRAFT_STATUSES.map(status => `'${status}'`).join(',')

export const RECEIPTED_DRAFT_STATUSES = ['finalized', 'superseded'] as const satisfies readonly DraftStatus[]

export const RECEIPTED_DRAFT_STATUS_SQL = RECEIPTED_DRAFT_STATUSES.map(status => `'${status}'`).join(',')

export function isReceiptedDraftStatus(status: string): boolean {
  return (RECEIPTED_DRAFT_STATUSES as readonly string[]).includes(status)
}
