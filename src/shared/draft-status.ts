/** 草稿状态：主进程、草稿索引与工作流共用 */
export type DraftStatus = 'draft' | 'revised' | 'reviewed' | 'finalized' | 'superseded' | 'archived'

/** 单章视图里一稿所处的位置：工作稿走写审修流程，其余三种只读。 */
export type DraftStatusPhase = 'working' | 'final' | 'superseded' | 'archived'

export interface DraftStatusInfo {
  /** 编辑器只读：定稿、被替换的定稿与已归档的旧稿都不能再改正文。 */
  readOnly: boolean
  /** 版本切换器与版本历史里的名字。 */
  label: readonly [zh: string, en: string]
  phase: DraftStatusPhase
}

/**
 * 每个状态的只读性、名字与阶段。新增状态时这里必须补一行，界面从这里取，
 * 不再各自写 `status === 'finalized'`。superseded 是本章重新定稿后被替换的旧定稿：
 * 定稿收据与正文都保留，但不再是这一章的权威定稿。
 */
export const DRAFT_STATUS_INFO: Readonly<Record<DraftStatus, DraftStatusInfo>> = {
  draft: { readOnly: false, label: ['草稿', 'Draft'], phase: 'working' },
  reviewed: { readOnly: false, label: ['草稿', 'Draft'], phase: 'working' },
  revised: { readOnly: false, label: ['修稿已合并', 'Revised'], phase: 'working' },
  finalized: { readOnly: true, label: ['定稿', 'Final'], phase: 'final' },
  superseded: { readOnly: true, label: ['已被替换的定稿', 'Replaced final'], phase: 'superseded' },
  archived: { readOnly: true, label: ['已归档', 'Archived'], phase: 'archived' },
}

/** 还能继续写、改、审的工作稿状态；旧版本审稿留下的 reviewed 也算（#411）。 */
export const WORKING_DRAFT_STATUSES = ['draft', 'revised', 'reviewed'] as const satisfies readonly DraftStatus[]

/** 参与「这一章最新一稿」比较的状态：工作稿加定稿，不含已归档与被替换的旧定稿。 */
export const CURRENT_DRAFT_STATUSES = [...WORKING_DRAFT_STATUSES, 'finalized'] as const satisfies readonly DraftStatus[]

/** CURRENT_DRAFT_STATUSES 的 SQL IN 列表片段，主进程查询「最新一稿」时共用。 */
export const CURRENT_DRAFT_STATUS_SQL = CURRENT_DRAFT_STATUSES.map(status => `'${status}'`).join(',')

/**
 * 带定稿收据的状态：当前权威定稿与被替换的旧定稿。正文冻结、不能普通删除，删除章节、
 * 转移校验与导入收据都按这一组认行。要的是「当前权威定稿」时仍写 `status = 'finalized'`。
 */
export const RECEIPTED_DRAFT_STATUSES = ['finalized', 'superseded'] as const satisfies readonly DraftStatus[]

/** RECEIPTED_DRAFT_STATUSES 的 SQL IN 列表片段。 */
export const RECEIPTED_DRAFT_STATUS_SQL = RECEIPTED_DRAFT_STATUSES.map(status => `'${status}'`).join(',')

export function isReceiptedDraftStatus(status: string): boolean {
  return (RECEIPTED_DRAFT_STATUSES as readonly string[]).includes(status)
}
