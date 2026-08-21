/** Path-free V2 sidebar state split by workspace, proposal, task, chapter, and editor concerns. */

import type { WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type { NovelStateReadResult } from '../command-rpc.ts'
import type {
  NovelAggregateRef,
  NovelArtifactProposalChange,
  NovelChapterContext,
  NovelChangeSet,
  NovelProposalApplyResult,
  NovelProposalChange,
  NovelProposalItemMutationResult,
  NovelProposalRegenerationResult,
  NovelProposalSummary,
  NovelTaskAggregate,
} from '../novel-store.ts'

/** The V2 browser surface crosses only opaque Workspace, proposal, and item identities. */
export interface NovelV2WorkbenchPort {
  readState(workspaceId: WorkspaceId, signal: AbortSignal): Promise<NovelStateReadResult>
  listProposals(workspaceId: WorkspaceId, signal: AbortSignal): Promise<readonly NovelProposalSummary[]>
  readChapterContext?(workspaceId: WorkspaceId, chapter: number, signal: AbortSignal): Promise<NovelChapterContext>
  readTask(workspaceId: WorkspaceId, taskId: string, signal: AbortSignal): Promise<NovelTaskAggregate>
  applyProposal?(workspaceId: WorkspaceId, proposalId: string, signal: AbortSignal): Promise<NovelProposalApplyResult>
  retryProposalItem?(workspaceId: WorkspaceId, proposalId: string, itemId: string, signal: AbortSignal): Promise<NovelProposalApplyResult>
  discardProposalItem?(workspaceId: WorkspaceId, proposalId: string, itemId: string, signal: AbortSignal): Promise<NovelProposalItemMutationResult>
  regenerateProposalItem?(workspaceId: WorkspaceId, proposalId: string, itemId: string, signal: AbortSignal): Promise<NovelProposalRegenerationResult>
}

/** One path-free workspace projection shown by the workbench. */
export interface NovelWorkspacePanelState {
  readonly workspaceId: WorkspaceId
  readonly project: NovelStateReadResult['project']
  readonly globalRevision: number
  readonly readOnly: boolean
  /** Authoritative aggregate projection used by this read-only detail layer. */
  readonly snapshot: NovelStateReadResult
}

/** Proposal queue state, including only Host-owned bundle and item lifecycle projections. */
export interface NovelProposalPanelState {
  readonly phase: 'loading' | 'ready' | 'failed'
  readonly items: readonly NovelProposalSummary[]
  readonly selectedId: string | undefined
  readonly selectedChange: number | undefined
  readonly message: string | undefined
}

/** Task projection state; recovery only reports the Host-owned resume cursor. */
export interface NovelTaskPanelState {
  readonly items: readonly NovelTaskAggregate[]
  readonly selectedId: string | undefined
  readonly message: string | undefined
}

/** Chapter-navigation state stays independent from the current detail view. */
export interface NovelChapterPanelState {
  readonly selected: number | undefined
  readonly items: NovelStateReadResult['chapters']
  /** Bounded Host context for the selected chapter; it never includes a local chapter-history reconstruction. */
  readonly context?: {
    readonly phase: 'idle' | 'loading' | 'ready' | 'failed'
    readonly chapter: number | undefined
    readonly previousFinal: NovelChapterContext['previousFinal']
    readonly message: string | undefined
  }
}

/** A single aggregate selected for the shell's editable/diff/version detail area. */
export interface NovelEditorPanelState {
  readonly target: NovelAggregateRef | undefined
  readonly phase: 'idle' | 'editing' | 'discarded'
  /** Whether this local detail came from an asset navigation or proposal change. */
  readonly source?: 'asset' | 'proposal'
  /** Authoritative global/aggregate versions that the local editor was derived from. */
  readonly baseGlobalRevision?: number
  readonly baseAggregateRevision?: number | undefined
  /** A local asset draft survived a newer authoritative value and must not be mistaken for current. */
  readonly stale?: boolean
  /** Current Host-authoritative aggregate value serialized for the local editor. */
  readonly current: string
  /** Proposal next value, present only when a persisted proposal is being inspected. */
  readonly next: string | undefined
  readonly aggregateRevision: number | undefined
  readonly draft: string
  readonly message: string | undefined
}

/** Complete render state for the V2 workbench shell. */
export type NovelV2WorkbenchState =
  | {
    readonly status: 'idle' | 'loading'
    readonly open: boolean
    readonly workspace: undefined
    readonly proposals: NovelProposalPanelState
    readonly tasks: NovelTaskPanelState
    readonly chapters: NovelChapterPanelState
    readonly editor: NovelEditorPanelState
  }
  | {
    readonly status: 'ready'
    readonly open: boolean
    readonly workspace: NovelWorkspacePanelState
    readonly proposals: NovelProposalPanelState
    readonly tasks: NovelTaskPanelState
    readonly chapters: NovelChapterPanelState
    readonly editor: NovelEditorPanelState
  }
  | {
    readonly status: 'error'
    readonly open: boolean
    readonly workspace: undefined
    readonly proposals: NovelProposalPanelState
    readonly tasks: NovelTaskPanelState
    readonly chapters: NovelChapterPanelState
    readonly editor: NovelEditorPanelState
    readonly message: string
  }

type NovelV2ReadyWorkbenchState = Extract<NovelV2WorkbenchState, { readonly status: 'ready' }>

const EMPTY_PROPOSALS: NovelProposalPanelState = {
  phase: 'ready', items: [], selectedId: undefined, selectedChange: undefined, message: undefined,
}
const EMPTY_TASKS: NovelTaskPanelState = { items: [], selectedId: undefined, message: undefined }
const EMPTY_CHAPTERS: NovelChapterPanelState = {
  selected: undefined,
  items: [],
  context: { phase: 'idle', chapter: undefined, previousFinal: undefined, message: undefined },
}
const EMPTY_EDITOR: NovelEditorPanelState = {
  target: undefined, phase: 'idle', current: '', next: undefined, aggregateRevision: undefined, draft: '', message: undefined,
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type SettledRead<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown }

/** Begin both Host reads even if a malformed port throws synchronously. */
function startRead<T>(read: () => Promise<T>): Promise<T> {
  try { return read() } catch (error) { return Promise.reject(error) }
}

/**
 * Preserve the first observed Host error, but do not finish its parent operation
 * until every sibling read has settled. This keeps dispose/whenIdle truthful.
 */
async function firstErrorAfterAllSettled<T, U>(
  left: Promise<T>,
  right: Promise<U>,
): Promise<readonly [T, U]> {
  let firstFailure: { readonly error: unknown } | undefined
  const settle = <Value>(read: Promise<Value>): Promise<SettledRead<Value>> => read.then(
    value => ({ ok: true, value }),
    error => {
      if (firstFailure === undefined) firstFailure = { error }
      return { ok: false, error }
    },
  )
  const [leftResult, rightResult] = await Promise.all([settle(left), settle(right)])
  if (firstFailure !== undefined) throw firstFailure.error
  if (!leftResult.ok) throw leftResult.error
  if (!rightResult.ok) throw rightResult.error
  return [leftResult.value, rightResult.value]
}

function aggregateLabel(target: NovelAggregateRef): string {
  if (target.kind === 'chapter') return `第 ${target.chapter} 章`
  if (target.kind === 'task') return `任务 ${target.taskId}`
  return target.kind
}

function textForValue(value: unknown): string { return JSON.stringify(value, null, 2) }

function aggregateFromSnapshot(state: NovelStateReadResult, target: NovelAggregateRef): unknown {
  switch (target.kind) {
    case 'project': return state.project
    case 'architecture': return state.architecture
    case 'characters': return state.characters
    case 'chapter': return state.chapters.find(chapter => chapter.chapter === target.chapter)
    case 'task': return state.tasks.find(task => task.taskId === target.taskId)
  }
}

function aggregateKey(target: NovelAggregateRef): string {
  if (target.kind === 'chapter') return `chapter:${target.chapter}`
  if (target.kind === 'task') return `task:${target.taskId}`
  return target.kind
}

function isArtifactProposalChange(change: NovelProposalChange | NovelChangeSet): change is NovelArtifactProposalChange {
  return 'kind' in change && (change.kind === 'artifact/draft'
    || change.kind === 'artifact/review' || change.kind === 'artifact/revision' || change.kind === 'chapter/select-final')
}

interface ProposalDiffBase {
  readonly value: unknown
  readonly chainBroken: boolean
}

function proposalDiffBase(
  state: NovelStateReadResult,
  proposal: NovelProposalSummary,
  index: number,
): ProposalDiffBase | undefined {
  const item = proposal.items[index]
  if (item === undefined) return undefined
  if (isArtifactProposalChange(item.change)) return undefined
  const authoritative = aggregateFromSnapshot(state, item.change.aggregate)
  const predicted = new Map<string, { readonly value: unknown; readonly revision: number | undefined }>()
  let globalRevision = state.globalRevision
  const predictionFor = (target: NovelAggregateRef): { readonly value: unknown; readonly revision: number | undefined } => {
    const key = aggregateKey(target)
    const existing = predicted.get(key)
    if (existing !== undefined) return existing
    const value = aggregateFromSnapshot(state, target)
    const initial = { value, revision: value === undefined ? 0 : aggregateRevision(value) }
    predicted.set(key, initial)
    return initial
  }
  const preceding = proposal.items
    .filter(candidate => candidate.itemOrder < item.itemOrder)
    .toSorted((left, right) => left.itemOrder - right.itemOrder)
  for (const candidate of preceding) {
    if (isArtifactProposalChange(candidate.change)) continue
    switch (candidate.status) {
      case 'applied':
      case 'discarded':
      case 'superseded':
        continue
      case 'stale':
      case 'failed':
        return { value: authoritative, chainBroken: true }
      case 'pending':
        break
    }
    const prediction = predictionFor(candidate.change.aggregate)
    if (candidate.change.baseGlobalRevision !== globalRevision
      || candidate.change.baseAggregateRevision !== prediction.revision) {
      return { value: authoritative, chainBroken: true }
    }
    predicted.set(aggregateKey(candidate.change.aggregate), {
      value: candidate.change.nextValue,
      revision: candidate.change.baseAggregateRevision + 1,
    })
    globalRevision += 1
  }
  switch (item.status) {
    case 'applied':
    case 'discarded':
    case 'superseded':
      return { value: authoritative, chainBroken: false }
    case 'stale':
    case 'failed':
      return { value: authoritative, chainBroken: true }
    case 'pending':
      break
  }
  const selectedPrediction = predictionFor(item.change.aggregate)
  if (item.change.baseGlobalRevision !== globalRevision
    || item.change.baseAggregateRevision !== selectedPrediction.revision) {
    return { value: authoritative, chainBroken: true }
  }
  return { value: selectedPrediction.value, chainBroken: false }
}

function aggregateRevision(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const revision = (value as { readonly revision?: unknown }).revision
  return typeof revision === 'number' ? revision : undefined
}

function draftForProposal(
  state: NovelStateReadResult,
  proposal: NovelProposalSummary,
  index: number,
): Pick<NovelEditorPanelState, 'target' | 'source' | 'current' | 'next' | 'aggregateRevision' | 'baseGlobalRevision' | 'baseAggregateRevision' | 'stale'> | undefined {
  const item = proposal.items[index]
  if (item === undefined) return undefined
  const change = item.change
  if (isArtifactProposalChange(change)) return undefined
  const base = proposalDiffBase(state, proposal, index)
  if (base === undefined) return undefined
  const current = base.value
  return {
    target: change.aggregate,
    source: 'proposal',
    current: textForValue(current),
    next: textForValue(change.nextValue),
    aggregateRevision: aggregateRevision(current),
    baseGlobalRevision: change.baseGlobalRevision,
    baseAggregateRevision: change.baseAggregateRevision,
    stale: false,
  }
}

function refreshedEditor(
  previous: NovelEditorPanelState | undefined,
  state: NovelStateReadResult,
  selectedProposal: NovelProposalSummary | undefined,
  selectedChange: number | undefined,
): NovelEditorPanelState {
  if (previous?.target === undefined) return EMPTY_EDITOR
  if (previous.source === 'proposal') {
    if (selectedProposal === undefined || selectedChange === undefined) return EMPTY_EDITOR
    const proposalEditor = draftForProposal(state, selectedProposal, selectedChange)
    const preservedDraft = previous.draft !== previous.next
    const stale = preservedDraft && previous.next !== proposalEditor?.next
    return proposalEditor === undefined
      ? EMPTY_EDITOR
      : {
          ...proposalEditor,
          phase: 'idle',
          draft: preservedDraft ? previous.draft : proposalEditor.next ?? '',
          stale,
          message: stale
            ? `提案已更新为全局版本 ${proposalEditor.baseGlobalRevision}；本地草稿已保留，必须重新核对。`
            : `提案版本基于全局版本 ${proposalEditor.baseGlobalRevision}；当前已读全局版本 ${state.globalRevision}。应用操作由后续命令工作流负责。`,
        }
  }
  const authoritative = aggregateFromSnapshot(state, previous.target)
  if (authoritative === undefined) return EMPTY_EDITOR
  const current = textForValue(authoritative)
  const stale = previous.current !== current
  return {
    ...previous,
    source: 'asset',
    current,
    next: undefined,
    aggregateRevision: aggregateRevision(authoritative),
    baseGlobalRevision: state.globalRevision,
    baseAggregateRevision: aggregateRevision(authoritative),
    stale,
    draft: previous.draft,
    message: stale
      ? '权威值已更新；本地草稿已保留，但它基于旧版本，保存前必须重新核对。'
      : previous.message,
  }
}

/**
 * Workspace controller: reads only Host-authoritative V2 state and folds it into the child panel states.
 * Mutating command preview/commit is intentionally not exposed by this #124 shell.
 */
export class NovelV2WorkbenchController {
  readonly #listeners = new Set<() => void>()
  #workspaceId: WorkspaceId | undefined
  #request = 0
  #active: AbortController | undefined
  #contextRequest = 0
  #activeContext: AbortController | undefined
  #taskRequest = 0
  #activeTask: AbortController | undefined
  #proposalRequest = 0
  #activeProposal: AbortController | undefined
  #inflight = new Set<Promise<void>>()
  #disposed = false
  #disposePromise: Promise<void> | undefined
  #retainedReady: NovelV2ReadyWorkbenchState | undefined
  #state: NovelV2WorkbenchState = {
    status: 'idle', open: false, workspace: undefined, proposals: EMPTY_PROPOSALS, tasks: EMPTY_TASKS,
    chapters: EMPTY_CHAPTERS, editor: EMPTY_EDITOR,
  }

  public constructor(private readonly port: NovelV2WorkbenchPort) {}

  public getSnapshot(): NovelV2WorkbenchState { return this.#state }

  public subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Select an opaque Workspace identity; no local path is accepted or retained. */
  public setWorkspace(workspaceId: WorkspaceId | undefined): void {
    if (this.#disposed) return
    if (workspaceId === this.#workspaceId) return
    this.#workspaceId = workspaceId
    this.#retainedReady = undefined
    this.#active?.abort()
    this.#cancelChapterContextRead()
    this.#cancelTaskRead()
    this.#cancelProposalOperation()
    if (workspaceId === undefined) {
      this.#set({
        status: 'idle', open: this.#state.open, workspace: undefined, proposals: EMPTY_PROPOSALS, tasks: EMPTY_TASKS,
        chapters: EMPTY_CHAPTERS, editor: EMPTY_EDITOR,
      })
      return
    }
    if (this.#state.open) void this.refresh()
  }

  /** Open the shell and begin reading the already-selected opaque Workspace. */
  public open(): Promise<void> {
    if (this.#disposed) return Promise.resolve()
    if (!this.#state.open) this.#set({ ...this.#state, open: true })
    return this.refresh()
  }

  /** Close the visual shell without dropping the selected Workspace or local draft. */
  public close(): void {
    if (!this.#state.open) return
    this.#set({ ...this.#state, open: false })
  }

  /** Refresh the current workspace state and its proposal queue through existing loopback reads. */
  public refresh(): Promise<void> {
    const workspaceId = this.#workspaceId
    if (this.#disposed || workspaceId === undefined) return Promise.resolve()
    const previous = this.#state.status === 'ready' ? this.#state : this.#retainedReady
    this.#active?.abort()
    this.#cancelChapterContextRead()
    this.#cancelTaskRead()
    const abort = new AbortController()
    this.#active = abort
    const request = ++this.#request
    this.#set({
      status: 'loading', open: this.#state.open, workspace: undefined,
      proposals: { ...this.#state.proposals, phase: 'loading', message: undefined },
      tasks: this.#state.tasks, chapters: this.#state.chapters, editor: this.#state.editor,
    })
    const pending = firstErrorAfterAllSettled(
      startRead(() => this.port.readState(workspaceId, abort.signal)),
      startRead(() => this.port.listProposals(workspaceId, abort.signal)),
    ).then(([state, proposals]) => {
      if (abort.signal.aborted || request !== this.#request || workspaceId !== this.#workspaceId) return
      const selectedProposal = proposals.some(proposal => proposal.proposalId === previous?.proposals.selectedId)
        ? previous?.proposals.selectedId
        : proposals[0]?.proposalId
      const selectedProposalValue = proposals.find(proposal => proposal.proposalId === selectedProposal)
      const previousChange = previous?.proposals.selectedChange
      const selectedChange = selectedProposalValue !== undefined
        && previous?.proposals.selectedId === selectedProposal
        && previousChange !== undefined
        && selectedProposalValue.items[previousChange] !== undefined
        ? previousChange
        : undefined
      const selectedTask = state.tasks.some(task => task.taskId === previous?.tasks.selectedId)
        ? previous?.tasks.selectedId
        : undefined
      const selectedChapter = state.chapters.some(chapter => chapter.chapter === previous?.chapters.selected)
        ? previous?.chapters.selected
        : state.chapters[0]?.chapter
      const editor = refreshedEditor(previous?.editor, state, selectedProposalValue, selectedChange)
      this.#set({
        status: 'ready', open: this.#state.open,
        workspace: {
          workspaceId, project: state.project, globalRevision: state.globalRevision, readOnly: state.readOnly, snapshot: state,
        },
        proposals: {
          phase: 'ready', items: proposals, selectedId: selectedProposal, selectedChange, message: undefined,
        },
        tasks: { items: state.tasks, selectedId: selectedTask, message: undefined },
        chapters: { selected: selectedChapter, items: state.chapters },
        editor,
      })
      if (selectedChapter !== undefined) void this.#readChapterContext(selectedChapter)
    }).catch(error => {
      if (abort.signal.aborted || request !== this.#request || workspaceId !== this.#workspaceId) return
      if (previous !== undefined) {
        this.#set({
          ...previous,
          open: this.#state.open,
          proposals: { ...previous.proposals, phase: 'failed', message: messageOf(error) },
        })
        return
      }
      this.#set({
        status: 'error', open: this.#state.open, workspace: undefined,
        proposals: { ...EMPTY_PROPOSALS, phase: 'failed', message: messageOf(error) },
        tasks: EMPTY_TASKS, chapters: EMPTY_CHAPTERS, editor: EMPTY_EDITOR, message: messageOf(error),
      })
    }).finally(() => {
      if (this.#active === abort) this.#active = undefined
    })
    this.#track(pending)
    return pending
  }

  /** Select one persisted proposal without applying or discarding it. */
  public selectProposal(proposalId: string | undefined): void {
    if (this.#state.status !== 'ready') return
    const selectedId = proposalId !== undefined && this.#state.proposals.items.some(item => item.proposalId === proposalId)
      ? proposalId
      : undefined
    this.#set({ ...this.#state, proposals: { ...this.#state.proposals, selectedId, selectedChange: undefined } })
  }

  /** Open one proposed single-aggregate replacement in the detail layer as JSON plus version data. */
  public openProposalChange(index: number): void {
    if (this.#state.status !== 'ready') return
    const proposal = this.#state.proposals.items.find(item => item.proposalId === this.#state.proposals.selectedId)
    if (proposal === undefined) return
    const item = proposal.items[index]
    if (item === undefined) return
    if (isArtifactProposalChange(item.change)) {
      this.#set({
        ...this.#state,
        proposals: { ...this.#state.proposals, selectedChange: index },
        editor: EMPTY_EDITOR,
      })
      return
    }
    const base = proposalDiffBase(this.#state.workspace.snapshot, proposal, index)
    const opened = draftForProposal(this.#state.workspace.snapshot, proposal, index)
    if (opened === undefined || base === undefined) return
    this.#set({
      ...this.#state,
      proposals: { ...this.#state.proposals, selectedChange: index },
      editor: {
        ...opened,
        phase: 'idle', draft: opened.next ?? '',
        message: `提案版本基于全局版本 ${opened.baseGlobalRevision}；当前已读全局版本 ${this.#state.workspace.globalRevision}。${base.chainBroken
          ? ' Proposal Bundle 的顺序 revision 链与权威快照不匹配；顺序应用时由 Host 按 stale revision 验证，本项差异以权威快照为基准。'
          : ' 应用与恢复由 Host Proposal Bundle 生命周期负责。'}`,
      },
    })
  }

  /** Ask the Host to apply the selected Proposal Bundle in its persisted item order. */
  public applySelectedProposal(): Promise<void> {
    if (this.#state.status !== 'ready') return Promise.resolve()
    const proposal = this.#state.proposals.items.find(item => item.proposalId === this.#state.proposals.selectedId)
    if (proposal === undefined) return Promise.resolve()
    if (proposal.status === 'stale') {
      return this.#proposalOperationUnavailable('Host 报告此 Proposal Bundle 已冲突；请先处理对应项，不能盲目应用。')
    }
    const workspaceId = this.#state.workspace.workspaceId
    const apply = this.port.applyProposal
    if (apply === undefined) return this.#proposalOperationUnavailable('Host 尚未提供 Proposal Bundle 应用命令。')
    return this.#runProposalOperation(proposal.proposalId, '提案应用', signal => apply(workspaceId, proposal.proposalId, signal))
  }

  /** Ask the Host to retry one failed Proposal Bundle item by opaque item identity. */
  public retryProposalItem(index: number): Promise<void> {
    if (this.#state.status !== 'ready') return Promise.resolve()
    const proposal = this.#state.proposals.items.find(item => item.proposalId === this.#state.proposals.selectedId)
    const item = proposal?.items[index]
    if (proposal === undefined || item === undefined) return Promise.resolve()
    const workspaceId = this.#state.workspace.workspaceId
    const retry = this.port.retryProposalItem
    if (retry === undefined) return this.#proposalOperationUnavailable('Host 尚未提供 Proposal Bundle 逐项重试命令。')
    return this.#runProposalOperation(proposal.proposalId, '提案项重试', signal => retry(workspaceId, proposal.proposalId, item.itemId, signal))
  }

  /** Ask the Host to durably discard one Proposal Bundle item. */
  public discardProposalItem(index: number): Promise<void> {
    if (this.#state.status !== 'ready') return Promise.resolve()
    const proposal = this.#state.proposals.items.find(item => item.proposalId === this.#state.proposals.selectedId)
    const item = proposal?.items[index]
    if (proposal === undefined || item === undefined) return Promise.resolve()
    const workspaceId = this.#state.workspace.workspaceId
    const discard = this.port.discardProposalItem
    if (discard === undefined) return this.#proposalOperationUnavailable('Host 尚未提供 Proposal Bundle 逐项放弃命令。')
    return this.#runProposalOperation(proposal.proposalId, '提案项放弃', signal => discard(workspaceId, proposal.proposalId, item.itemId, signal))
  }

  /** Ask the Host to regenerate one item; the Host returns and persists the opaque ticket. */
  public regenerateProposalItem(index: number): Promise<void> {
    if (this.#state.status !== 'ready') return Promise.resolve()
    const proposal = this.#state.proposals.items.find(item => item.proposalId === this.#state.proposals.selectedId)
    const item = proposal?.items[index]
    if (proposal === undefined || item === undefined) return Promise.resolve()
    const workspaceId = this.#state.workspace.workspaceId
    const regenerate = this.port.regenerateProposalItem
    if (regenerate === undefined) return this.#proposalOperationUnavailable('Host 尚未提供 Proposal Bundle 逐项重新生成命令。')
    return this.#runProposalOperation(proposal.proposalId, '提案项重新生成', signal => regenerate(workspaceId, proposal.proposalId, item.itemId, signal))
  }

  /** Whether every Host-owned per-item lifecycle action is wired by the active client port. */
  public proposalLifecycleAvailable(): boolean {
    return this.port.retryProposalItem !== undefined
      && this.port.discardProposalItem !== undefined
      && this.port.regenerateProposalItem !== undefined
  }

  /** Select a persisted task; detail reads stay path-free and use the existing task/read contract. */
  public async selectTask(taskId: string | undefined): Promise<void> {
    if (this.#disposed || this.#state.status !== 'ready') return
    const task = this.#state.tasks.items.find(item => item.taskId === taskId)
    if (task === undefined) {
      this.#cancelTaskRead()
      this.#set({ ...this.#state, tasks: { ...this.#state.tasks, selectedId: undefined, message: undefined } })
      return
    }
    const selectedTaskId = task.taskId
    this.#set({ ...this.#state, tasks: { ...this.#state.tasks, selectedId: selectedTaskId, message: undefined } })
    const workspaceId = this.#state.workspace.workspaceId
    this.#activeTask?.abort()
    const abort = new AbortController()
    this.#activeTask = abort
    const request = ++this.#taskRequest
    const pending = this.port.readTask(workspaceId, task.taskId, abort.signal).then(refreshed => {
      if (!this.#isCurrentTaskRead(abort, request, workspaceId, selectedTaskId)) return
      this.#set({
        ...this.#state,
        tasks: {
          ...this.#state.tasks,
          items: this.#state.tasks.items.map(item => item.taskId === selectedTaskId ? refreshed : item),
          message: undefined,
        },
      })
    }).catch(error => {
      if (!this.#isCurrentTaskRead(abort, request, workspaceId, selectedTaskId)) return
      this.#set({ ...this.#state, tasks: { ...this.#state.tasks, message: messageOf(error) } })
    }).finally(() => {
      if (this.#activeTask === abort) this.#activeTask = undefined
    })
    this.#track(pending)
    return pending
  }

  /** Keep chapter navigation independent from proposal and task selections. */
  public selectChapter(chapter: number): void {
    if (this.#state.status !== 'ready') return
    if (!this.#state.chapters.items.some(item => item.chapter === chapter)) return
    this.#set({ ...this.#state, chapters: { ...this.#state.chapters, selected: chapter } })
    void this.#readChapterContext(chapter)
  }

  /** Read only the Host-bounded previous-final context for the selected chapter. */
  #readChapterContext(chapter: number): Promise<void> {
    if (this.#disposed || this.#state.status !== 'ready') return Promise.resolve()
    const readChapterContext = this.port.readChapterContext
    // Transitional test and embedding ports may predate #126; production wiring always supplies this RPC.
    if (readChapterContext === undefined) return Promise.resolve()
    const workspaceId = this.#state.workspace.workspaceId
    this.#activeContext?.abort()
    const abort = new AbortController()
    this.#activeContext = abort
    const request = ++this.#contextRequest
    this.#set({
      ...this.#state,
      chapters: {
        ...this.#state.chapters,
        context: { phase: 'loading', chapter, previousFinal: undefined, message: undefined },
      },
    })
    const pending = readChapterContext(workspaceId, chapter, abort.signal).then(context => {
      if (!this.#isCurrentChapterContextRead(abort, request, workspaceId, chapter)) return
      this.#set({
        ...this.#state,
        chapters: {
          ...this.#state.chapters,
          context: {
            phase: 'ready', chapter: context.chapter, previousFinal: context.previousFinal, message: undefined,
          },
        },
      })
    }).catch(error => {
      if (!this.#isCurrentChapterContextRead(abort, request, workspaceId, chapter)) return
      this.#set({
        ...this.#state,
        chapters: {
          ...this.#state.chapters,
          context: { phase: 'failed', chapter, previousFinal: undefined, message: messageOf(error) },
        },
      })
    }).finally(() => {
      if (this.#activeContext === abort) this.#activeContext = undefined
    })
    this.#track(pending)
    return pending
  }

  /** Open one authoritative aggregate only as a local shell draft; it never issues a write. */
  public openAsset(target: NovelAggregateRef): void {
    if (this.#state.status !== 'ready') return
    const currentValue = aggregateFromSnapshot(this.#state.workspace.snapshot, target)
    if (currentValue === undefined) return
    const current = textForValue(currentValue)
    this.#set({
      ...this.#state,
      editor: {
        target, phase: 'editing', source: 'asset', current, next: undefined,
        aggregateRevision: aggregateRevision(currentValue), baseGlobalRevision: this.#state.workspace.globalRevision,
        baseAggregateRevision: aggregateRevision(currentValue), stale: false, draft: current,
        message: `${aggregateLabel(target)} 已打开；保存操作尚未接入此工作台。`,
      },
    })
  }

  /** Update a local detail draft without sending a browser mutation request. */
  public updateEditor(draft: string): void {
    if (this.#state.status !== 'ready' || this.#state.editor.target === undefined) return
    this.#set({ ...this.#state, editor: { ...this.#state.editor, phase: 'editing', draft, message: '本地草稿未保存。' } })
  }

  /** Discard only local unsubmitted text; persisted proposals and aggregates remain unchanged. */
  public discardEditor(): void {
    if (this.#state.status !== 'ready' || this.#state.editor.target === undefined) return
    this.#set({ ...this.#state, editor: { ...this.#state.editor, phase: 'discarded', draft: '', message: '已放弃本地未保存草稿。' } })
  }

  /** Await every currently in-flight Host read, including superseded requests that still need to settle. */
  public async whenIdle(): Promise<void> { await this.#settleInflight() }

  /** Stop active V2 reads when the Host disconnects and keep the last ready selection only for a later reconnect. */
  public disconnected(): void {
    if (this.#state.status === 'ready') this.#retainedReady = this.#state
    this.#request += 1
    this.#active?.abort()
    this.#active = undefined
    this.#cancelChapterContextRead()
    this.#cancelTaskRead()
    this.#cancelProposalOperation()
    this.#set({
      status: 'error', open: this.#state.open, workspace: undefined,
      proposals: { ...EMPTY_PROPOSALS, phase: 'failed', message: 'Harness 连接已断开，恢复连接后重新读取。' },
      tasks: EMPTY_TASKS, chapters: EMPTY_CHAPTERS, editor: EMPTY_EDITOR,
      message: 'Harness 连接已断开，恢复连接后重新读取。',
    })
  }

  /** Abort outstanding loopback reads and release render subscribers on client unload. */
  public dispose(): Promise<void> {
    if (this.#disposePromise !== undefined) return this.#disposePromise
    this.#disposed = true
    this.#request += 1
    this.#active?.abort()
    this.#cancelChapterContextRead()
    this.#cancelTaskRead()
    this.#cancelProposalOperation()
    this.#retainedReady = undefined
    this.#disposePromise = this.#settleInflight().then(() => { this.#listeners.clear() })
    return this.#disposePromise
  }

  #proposalOperationUnavailable(message: string): Promise<void> {
    this.#setProposalMessage(message)
    return Promise.resolve()
  }

  #runProposalOperation(
    proposalId: string,
    label: string,
    operation: (signal: AbortSignal) => Promise<unknown>,
  ): Promise<void> {
    if (this.#state.status !== 'ready') return Promise.resolve()
    if (this.#state.workspace.readOnly) {
      this.#setProposalMessage('当前 Workspace 为只读，不能变更 Proposal Bundle。')
      return Promise.resolve()
    }
    if (this.#activeProposal !== undefined) {
      this.#setProposalMessage('Proposal Bundle 生命周期操作正在进行中。')
      return Promise.resolve()
    }
    const workspaceId = this.#state.workspace.workspaceId
    const request = ++this.#proposalRequest
    const abort = new AbortController()
    this.#activeProposal = abort
    const pending = Promise.resolve().then(() => operation(abort.signal)).then(async () => {
      if (!this.#isCurrentProposalMutation(abort, request, workspaceId)) return
      await this.refresh()
      if (!this.#isCurrentProposalOperation(abort, request, workspaceId, proposalId)) return
      this.#setProposalMessage(`${label}已由 Host 处理；已刷新权威 Proposal Bundle 状态。`)
    }).catch(error => {
      if (abort.signal.aborted) return
      if (!this.#isCurrentProposalOperation(abort, request, workspaceId, proposalId)) return
      this.#setProposalMessage(`${label}失败：${messageOf(error)}`)
    }).finally(() => {
      if (this.#activeProposal === abort) this.#activeProposal = undefined
    })
    this.#track(pending)
    return pending
  }

  #setProposalMessage(message: string | undefined): void {
    if (this.#state.status !== 'ready') return
    this.#set({ ...this.#state, proposals: { ...this.#state.proposals, message } })
  }

  #track(pending: Promise<void>): void {
    this.#inflight.add(pending)
    void pending.then(
      () => { this.#inflight.delete(pending) },
      () => { this.#inflight.delete(pending) },
    )
  }

  async #settleInflight(): Promise<void> {
    while (this.#inflight.size > 0) {
      await Promise.all([...this.#inflight].map(pending => pending.catch(() => {})))
    }
  }

  #cancelTaskRead(): void {
    this.#taskRequest += 1
    this.#activeTask?.abort()
    this.#activeTask = undefined
  }

  #cancelChapterContextRead(): void {
    this.#contextRequest += 1
    this.#activeContext?.abort()
    this.#activeContext = undefined
  }

  #cancelProposalOperation(): void {
    this.#proposalRequest += 1
    this.#activeProposal?.abort()
    this.#activeProposal = undefined
  }

  #isCurrentProposalOperation(
    abort: AbortController,
    request: number,
    workspaceId: WorkspaceId,
    proposalId: string,
  ): boolean {
    return this.#isCurrentProposalMutation(abort, request, workspaceId)
      && this.#state.proposals.selectedId === proposalId
  }

  #isCurrentProposalMutation(
    abort: AbortController,
    request: number,
    workspaceId: WorkspaceId,
  ): boolean {
    return !abort.signal.aborted
      && request === this.#proposalRequest
      && this.#state.status === 'ready'
      && this.#state.workspace.workspaceId === workspaceId
  }

  #isCurrentTaskRead(
    abort: AbortController,
    request: number,
    workspaceId: WorkspaceId,
    taskId: string,
  ): boolean {
    return !abort.signal.aborted
      && request === this.#taskRequest
      && this.#state.status === 'ready'
      && this.#state.workspace.workspaceId === workspaceId
      && this.#state.tasks.selectedId === taskId
  }

  #isCurrentChapterContextRead(
    abort: AbortController,
    request: number,
    workspaceId: WorkspaceId,
    chapter: number,
  ): boolean {
    return !abort.signal.aborted
      && request === this.#contextRequest
      && this.#state.status === 'ready'
      && this.#state.workspace.workspaceId === workspaceId
      && this.#state.chapters.selected === chapter
  }

  #set(state: NovelV2WorkbenchState): void {
    this.#state = state
    if (state.status === 'ready') this.#retainedReady = state
    for (const listener of this.#listeners) listener()
  }
}
