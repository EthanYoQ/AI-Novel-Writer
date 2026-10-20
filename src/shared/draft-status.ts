/** 草稿状态：主进程、草稿索引与工作流共用 */
export type DraftStatus = 'draft' | 'revised' | 'reviewed' | 'finalized' | 'archived'

/** 还能继续写、改、审的工作稿状态；旧版本审稿留下的 reviewed 也算（#411）。 */
export const WORKING_DRAFT_STATUSES = ['draft', 'revised', 'reviewed'] as const satisfies readonly DraftStatus[]

/** 参与「这一章最新一稿」比较的状态：工作稿加定稿，不含已归档。 */
export const CURRENT_DRAFT_STATUSES = [...WORKING_DRAFT_STATUSES, 'finalized'] as const satisfies readonly DraftStatus[]

/** CURRENT_DRAFT_STATUSES 的 SQL IN 列表片段，主进程查询「最新一稿」时共用。 */
export const CURRENT_DRAFT_STATUS_SQL = CURRENT_DRAFT_STATUSES.map(status => `'${status}'`).join(',')
