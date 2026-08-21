/** Path-free V2 sidebar state split by workspace, proposal, task, chapter, and editor concerns. */

import type { WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  NovelProposalListResult,
  NovelStateReadResult,
} from '../command-rpc.ts'
import type {
  NovelAggregateRef,
  NovelProposalSummary,
  NovelTaskAggregate,
} from '../novel-store.ts'

/** The V2 browser surface only calls existing read-only loopback endpoints. */
export interface NovelV2WorkbenchPort {
  readState(workspaceId: WorkspaceId, signal: AbortSignal): Promise<NovelStateReadResult>
  listProposals(workspaceId: WorkspaceId, signal: AbortSignal): Promise<NovelProposalListResult['proposals']>
  readTask(workspaceId: WorkspaceId, taskId: string, signal: AbortSignal): Promise<NovelTaskAggregate>
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

/** Proposal queue state; proposal execution remains outside the #124 shell. */
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
const EMPTY_CHAPTERS: NovelChapterPanelState = { selected: undefined, items: [] }
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
  const change = proposal.changes[index]
  if (change === undefined) return undefined
  const current = aggregateFromSnapshot(state, change.aggregate)
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
  #taskRequest = 0
  #activeTask: AbortController | undefined
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
    this.#cancelTaskRead()
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
        && selectedProposalValue.changes[previousChange] !== undefined
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
    const opened = draftForProposal(this.#state.workspace.snapshot, proposal, index)
    if (opened === undefined) return
    this.#set({
      ...this.#state,
      proposals: { ...this.#state.proposals, selectedChange: index },
      editor: {
        ...opened,
        phase: 'idle', draft: opened.next ?? '',
        message: `提案版本基于全局版本 ${opened.baseGlobalRevision}；当前已读全局版本 ${this.#state.workspace.globalRevision}。应用操作由后续命令工作流负责。`,
      },
    })
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
    this.#cancelTaskRead()
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
    this.#cancelTaskRead()
    this.#retainedReady = undefined
    this.#disposePromise = this.#settleInflight().then(() => { this.#listeners.clear() })
    return this.#disposePromise
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

  #set(state: NovelV2WorkbenchState): void {
    this.#state = state
    if (state.status === 'ready') this.#retainedReady = state
    for (const listener of this.#listeners) listener()
  }
}
