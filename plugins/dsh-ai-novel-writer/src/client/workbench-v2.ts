/** Path-free V2 sidebar state split by workspace, proposal, task, chapter, and authoring concerns. */

import type { SessionId, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  NovelStateReadResult,
  NovelWorkspaceInitializeRequest,
  NovelWorkspaceInitializeResult,
  NovelWorkspaceStateReadResult,
} from '../command-rpc.ts'
import type {
  NovelChapterContext,
  NovelProposalApplyResult,
  NovelProposalItemMutationResult,
  NovelProposalRegenerationResult,
  NovelProposalSummary,
  NovelArchitectureNextValue,
  NovelChapterNextValue,
  NovelCharactersNextValue,
  NovelProjectNextValue,
  NovelTaskAggregate,
} from '../novel-store.ts'
import {
  EMPTY_V2_AUTHORING,
  V2_DUPLICATE_QUEUED_AUTHORING_REQUEST_MESSAGE,
  v2AuthoringBusy,
  v2AuthoringInputHasValue,
  v2AuthoringPrompt,
  type NovelV2AuthoringInput,
  type NovelV2AuthoringStage,
  type NovelV2AuthoringState,
} from './v2-authoring.ts'
export type { NovelV2AuthoringStage, NovelV2AuthoringState } from './v2-authoring.ts'

/** The V2 browser surface crosses only opaque Workspace, proposal, and item identities. */
export interface NovelV2WorkbenchPort {
  /** The clean-workspace-aware V2 state endpoint; this is the only production state read. */
  readWorkspaceState?(workspaceId: WorkspaceId, signal: AbortSignal): Promise<NovelV2WorkspaceStateReadResult>
  /** Compatibility seam for older isolated controller tests; the installed V2 port uses readWorkspaceState. */
  readState?(workspaceId: WorkspaceId, signal: AbortSignal): Promise<NovelStateReadResult>
  listProposals(workspaceId: WorkspaceId, signal: AbortSignal): Promise<readonly NovelProposalSummary[]>
  initializeWorkspace?(workspaceId: WorkspaceId, draft: NovelV2WorkspaceInitializationDraft, signal: AbortSignal): Promise<NovelV2WorkspaceInitializeResult>
  readChapterContext?(workspaceId: WorkspaceId, chapter: number, signal: AbortSignal): Promise<NovelChapterContext>
  readTask(workspaceId: WorkspaceId, taskId: string, signal: AbortSignal): Promise<NovelTaskAggregate>
  applyProposal?(workspaceId: WorkspaceId, proposalId: string, signal: AbortSignal): Promise<NovelProposalApplyResult>
  retryProposalItem?(workspaceId: WorkspaceId, proposalId: string, itemId: string, signal: AbortSignal): Promise<NovelProposalApplyResult>
  discardProposalItem?(workspaceId: WorkspaceId, proposalId: string, itemId: string, signal: AbortSignal): Promise<NovelProposalItemMutationResult>
  regenerateProposalItem?(workspaceId: WorkspaceId, proposalId: string, itemId: string, signal: AbortSignal): Promise<NovelProposalRegenerationResult>
  /** Check the selected browser Session's local queue before submitting an identical authoring request. */
  hasQueuedAuthoringRequest?(sessionId: SessionId, text: string): boolean
  /** Queue a deterministic local authoring prompt on the selected opaque Session. */
  prompt?(
    sessionId: SessionId,
    text: string,
  ): Promise<{ readonly ok: true; readonly value: { readonly accepted: true } } | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }>
}

/** Closed, path-free values a user may submit only to create an empty V2 workspace. */
export type NovelV2WorkspaceInitializationDraft = Omit<NovelWorkspaceInitializeRequest, 'workspaceId'>

/** The Host's initial authoritative state after one user-originated V2 initialization. */
export type NovelV2WorkspaceInitializeResult = NovelWorkspaceInitializeResult

/** Closed success union from Host `workspace/state/read`; it never uses an RPC error as product state. */
export type NovelV2WorkspaceStateReadResult = NovelWorkspaceStateReadResult

/** Form state for a user-originated initialization; it is never a model prompt or local write. */
export interface NovelV2WorkspaceInitializationState {
  readonly phase: 'editing' | 'submitting' | 'error'
  readonly draft: NovelV2WorkspaceInitializationDraft
  readonly message: string | undefined
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

/** Complete render state for the V2 workbench shell. */
export type NovelV2WorkbenchState =
  | {
    readonly status: 'idle' | 'loading'
    readonly open: boolean
    readonly workspace: undefined
    readonly proposals: NovelProposalPanelState
    readonly tasks: NovelTaskPanelState
    readonly chapters: NovelChapterPanelState
    readonly authoring: NovelV2AuthoringState
  }
  | {
    readonly status: 'ready'
    readonly open: boolean
    readonly workspace: NovelWorkspacePanelState
    readonly proposals: NovelProposalPanelState
    readonly tasks: NovelTaskPanelState
    readonly chapters: NovelChapterPanelState
    readonly authoring: NovelV2AuthoringState
  }
  | {
    readonly status: 'not-initialized'
    readonly open: boolean
    readonly workspace: undefined
    readonly proposals: NovelProposalPanelState
    readonly tasks: NovelTaskPanelState
    readonly chapters: NovelChapterPanelState
    readonly authoring: NovelV2AuthoringState
    readonly initialization: NovelV2WorkspaceInitializationState
  }
  | {
    readonly status: 'error'
    readonly open: boolean
    readonly workspace: undefined
    readonly proposals: NovelProposalPanelState
    readonly tasks: NovelTaskPanelState
    readonly chapters: NovelChapterPanelState
    readonly authoring: NovelV2AuthoringState
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
function defaultInitializationDraft(): NovelV2WorkspaceInitializationDraft {
  return {
    title: '', language: 'zh-CN', genre: '', plannedChapters: 20, targetWordsPerChapter: 3_000,
    creativeStrategy: 'auto', structureMode: 'three-act', narrativePov: 'third-limited', globalGuidance: '',
  }
}

function initializationState(
  draft: NovelV2WorkspaceInitializationDraft = defaultInitializationDraft(),
  phase: NovelV2WorkspaceInitializationState['phase'] = 'editing',
  message: string | undefined = undefined,
): NovelV2WorkspaceInitializationState {
  return { draft, phase, message }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Keep an interrupted local author draft retryable without claiming that its Session turn settled. */
function retryableAuthoringAfterDisconnect(authoring: NovelV2AuthoringState): NovelV2AuthoringState {
  if (!v2AuthoringBusy(authoring.phase)) return authoring
  return {
    ...authoring,
    phase: 'error',
    message: '连接已断开，创作请求未完成；你的本地创作要求仍已保留，可以重新提交。',
  }
}

function initializationValidationMessage(draft: NovelV2WorkspaceInitializationDraft): string | undefined {
  if (draft.title.trim() === '') return '请填写小说标题。'
  if (draft.language.trim() === '') return '请填写语言。'
  if (draft.genre.trim() === '') return '请填写类型。'
  if (!Number.isSafeInteger(draft.plannedChapters) || draft.plannedChapters <= 0) return '计划章数必须是正整数。'
  if (!Number.isSafeInteger(draft.targetWordsPerChapter) || draft.targetWordsPerChapter <= 0) return '每章目标字数必须是正整数。'
  if (!['auto', 'fluent-drafting', 'consistency-first', 'deep-planning'].includes(draft.creativeStrategy)) return '创作策略无效。'
  if (!['episodic', 'three-act', 'multi-thread'].includes(draft.structureMode)) return '结构模式无效。'
  if (!['first', 'third-limited', 'third-omniscient', 'multi-pov'].includes(draft.narrativePov)) return '叙事视角无效。'
  return undefined
}

/** A local chapter target is valid only inside the project's authoritative planned range. */
function isPlannedChapterNumber(chapter: number | undefined, plannedChapters: number): chapter is number {
  return chapter !== undefined && Number.isSafeInteger(chapter) && chapter > 0 && chapter <= plannedChapters
}

/** Begin one Host read even if a malformed port throws synchronously. */
function startRead<T>(read: () => Promise<T>): Promise<T> {
  try { return read() } catch (error) { return Promise.reject(error) }
}

type NovelProseArtifact = NovelStateReadResult['artifacts'][number] & { readonly kind: 'draft' | 'revision' }

function isProseArtifact(value: NovelStateReadResult['artifacts'][number] | undefined): value is NovelProseArtifact {
  return value?.kind === 'draft' || value?.kind === 'revision'
}

/** A premise is the smallest authoritative architecture baseline that can ground character work. */
function hasMeaningfulArchitecture(snapshot: NovelStateReadResult): boolean {
  return snapshot.architecture.premise.trim() !== ''
}

/** One browser-only draft keyed to its selected authoring target. */
interface LocalAuthoringDraft {
  readonly brief: string
  readonly input: NovelV2AuthoringInput | undefined
  readonly pendingProposalItem: NovelV2AuthoringState['pendingProposalItem']
}

interface LocalAuthoringTarget {
  readonly stage: NovelV2AuthoringStage
  readonly chapter: number | undefined
}

function authoringDraftKey(stage: NovelV2AuthoringStage, chapter: number | undefined): string {
  return `${stage}:${chapter === undefined ? 'global' : chapter}`
}

type ProposalChange = NovelProposalSummary['items'][number]['change']
type AggregateProposalChange = Extract<ProposalChange, { readonly aggregate: unknown }>
type ProjectProposalChange = AggregateProposalChange & {
  readonly aggregate: { readonly kind: 'project' }
  readonly nextValue: NovelProjectNextValue
}
type ArchitectureProposalChange = AggregateProposalChange & {
  readonly aggregate: { readonly kind: 'architecture' }
  readonly nextValue: NovelArchitectureNextValue
}
type CharactersProposalChange = AggregateProposalChange & {
  readonly aggregate: { readonly kind: 'characters' }
  readonly nextValue: NovelCharactersNextValue
}
type ChapterProposalChange = AggregateProposalChange & {
  readonly aggregate: { readonly kind: 'chapter'; readonly chapter: number }
  readonly nextValue: NovelChapterNextValue
}
type DraftProposalChange = Extract<ProposalChange, { readonly kind: 'artifact/draft' }>
type RevisionProposalChange = Extract<ProposalChange, { readonly kind: 'artifact/revision' }>

function isAggregateProposalChange(change: ProposalChange): change is AggregateProposalChange {
  return 'aggregate' in change && 'nextValue' in change
}

function isProjectProposalChange(change: ProposalChange): change is ProjectProposalChange {
  return isAggregateProposalChange(change) && change.aggregate.kind === 'project'
}

function isArchitectureProposalChange(change: ProposalChange): change is ArchitectureProposalChange {
  return isAggregateProposalChange(change) && change.aggregate.kind === 'architecture'
}

function isCharactersProposalChange(change: ProposalChange): change is CharactersProposalChange {
  return isAggregateProposalChange(change) && change.aggregate.kind === 'characters'
}

function isChapterProposalChange(change: ProposalChange): change is ChapterProposalChange {
  return isAggregateProposalChange(change) && change.aggregate.kind === 'chapter'
}

function isDraftProposalChange(change: ProposalChange): change is DraftProposalChange {
  return 'kind' in change && change.kind === 'artifact/draft'
}

function isRevisionProposalChange(change: ProposalChange): change is RevisionProposalChange {
  return 'kind' in change && change.kind === 'artifact/revision'
}

function chapterCharacterNames(snapshot: NovelStateReadResult, characterIds: readonly string[]): string {
  const names = new Map(snapshot.characters.items.map(character => [character.characterId, character.name.trim() || character.characterId]))
  return characterIds.map(characterId => names.get(characterId) ?? characterId).join('\n')
}

function charactersAuthoringValues(change: CharactersProposalChange): Readonly<Record<string, string>> {
  const values: Record<string, string> = {}
  const names = new Map(change.nextValue.items.map(character => [character.characterId, character.name.trim() || character.characterId]))
  for (const [index, character] of change.nextValue.items.entries()) {
    values[`character-${index}-name`] = character.name
    values[`character-${index}-role`] = character.role
    values[`character-${index}-summary`] = character.summary
    values[`character-${index}-goal`] = character.goal
    values[`character-${index}-currentState`] = character.currentState
    values[`character-${index}-notes`] = character.notes
  }
  if (change.nextValue.items.length === 0) values.newCharacters = ''
  values.relationships = change.nextValue.relationships
    .map(relationship => [
      names.get(relationship.fromCharacterId) ?? relationship.fromCharacterId,
      names.get(relationship.toCharacterId) ?? relationship.toCharacterId,
      relationship.relation,
      relationship.notes,
    ].join(' | '))
    .join('\n')
  return values
}

function authoringInputFromProposal(
  stage: NovelV2AuthoringStage,
  chapter: number | undefined,
  change: ProposalChange,
  snapshot: NovelStateReadResult,
): NovelV2AuthoringInput | undefined {
  if (isProjectProposalChange(change) && stage === 'project-refine') {
      return {
        kind: 'structured', stage, chapter: undefined,
        values: {
          title: change.nextValue.title,
          language: change.nextValue.language,
          genre: change.nextValue.genre,
          plannedChapters: String(change.nextValue.plannedChapters),
          targetWordsPerChapter: String(change.nextValue.targetWordsPerChapter),
          creativeStrategy: change.nextValue.creativeStrategy,
          structureMode: change.nextValue.structureMode,
          narrativePov: change.nextValue.narrativePov,
          globalGuidance: change.nextValue.globalGuidance,
        },
      }
  }
  if (isArchitectureProposalChange(change) && stage === 'architecture') {
      return {
        kind: 'structured', stage, chapter: undefined,
        values: {
          premise: change.nextValue.premise,
          characterGraph: change.nextValue.characterGraph,
          world: change.nextValue.world,
          styleConstraints: change.nextValue.styleConstraints,
          referenceWorks: change.nextValue.referenceWorks.join('\n'),
        },
      }
  }
  if (isArchitectureProposalChange(change) && stage === 'outline') {
      return { kind: 'structured', stage, chapter: undefined, values: { plotOutline: change.nextValue.plotOutline } }
  }
  if (isCharactersProposalChange(change) && stage === 'characters') {
      return { kind: 'structured', stage, chapter: undefined, values: charactersAuthoringValues(change) }
  }
  if (isChapterProposalChange(change) && stage === 'chapter-blueprint' && chapter !== undefined
    && change.aggregate.chapter === chapter) {
      return {
        kind: 'structured', stage, chapter,
        values: {
          title: change.nextValue.title,
          purpose: change.nextValue.purpose,
          plotBeats: change.nextValue.plotBeats.join('\n'),
          characters: chapterCharacterNames(snapshot, change.nextValue.characters),
          keyEvents: change.nextValue.keyEvents.join('\n'),
          suspense: change.nextValue.suspense,
          status: change.nextValue.status,
        },
      }
  }
  if (isDraftProposalChange(change) && stage === 'draft' && chapter !== undefined && change.chapter === chapter) {
    return { kind: 'prose', content: change.content }
  }
  if (isRevisionProposalChange(change) && stage === 'revision' && chapter !== undefined && change.chapter === chapter) {
    return { kind: 'prose', content: change.content }
  }
  return undefined
}

/**
 * Workspace controller: reads only Host-authoritative V2 state and folds it into the child panel states.
 * Mutating command preview/commit is intentionally not exposed by this #124 shell.
 */
export class NovelV2WorkbenchController {
  readonly #listeners = new Set<() => void>()
  #workspaceId: WorkspaceId | undefined
  #sessionId: SessionId | undefined
  #request = 0
  #active: AbortController | undefined
  #contextRequest = 0
  #activeContext: AbortController | undefined
  #taskRequest = 0
  #activeTask: AbortController | undefined
  #proposalRequest = 0
  #activeProposal: AbortController | undefined
  #initializationRequest = 0
  #activeInitialization: AbortController | undefined
  #authoringRequest = 0
  #authoringActionNumber = 0
  #authoringCorrelationText: string | undefined
  #authoringDrafts = new Map<string, LocalAuthoringDraft>()
  #inflight = new Set<Promise<void>>()
  #disposed = false
  #disposePromise: Promise<void> | undefined
  #retainedReady: NovelV2ReadyWorkbenchState | undefined
  #state: NovelV2WorkbenchState = {
    status: 'idle', open: false, workspace: undefined, proposals: EMPTY_PROPOSALS, tasks: EMPTY_TASKS,
    chapters: EMPTY_CHAPTERS, authoring: EMPTY_V2_AUTHORING,
  }

  public constructor(private readonly port: NovelV2WorkbenchPort) {}

  public getSnapshot(): NovelV2WorkbenchState { return this.#state }

  public subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Bind only the opaque active Session used for normal prompt submission. */
  public setSession(sessionId: SessionId | undefined): void {
    if (this.#disposed || sessionId === this.#sessionId) return
    this.#sessionId = sessionId
    this.#authoringRequest += 1
    this.#authoringCorrelationText = undefined
    this.#authoringDrafts.clear()
    this.#set({ ...this.#state, authoring: EMPTY_V2_AUTHORING })
  }

  /** Select an opaque Workspace identity; no local path is accepted or retained. */
  public setWorkspace(workspaceId: WorkspaceId | undefined): void {
    if (this.#disposed) return
    if (workspaceId === this.#workspaceId) return
    this.#workspaceId = workspaceId
    this.#retainedReady = undefined
    this.#authoringRequest += 1
    this.#authoringCorrelationText = undefined
    this.#authoringDrafts.clear()
    this.#active?.abort()
    this.#cancelChapterContextRead()
    this.#cancelTaskRead()
    this.#cancelProposalOperation()
    this.#cancelWorkspaceInitialization()
    if (workspaceId === undefined) {
      this.#set({
        status: 'idle', open: this.#state.open, workspace: undefined, proposals: EMPTY_PROPOSALS, tasks: EMPTY_TASKS,
        chapters: EMPTY_CHAPTERS, authoring: EMPTY_V2_AUTHORING,
      })
      return
    }
    this.#set({
      status: 'idle', open: this.#state.open, workspace: undefined, proposals: EMPTY_PROPOSALS, tasks: EMPTY_TASKS,
      chapters: EMPTY_CHAPTERS, authoring: EMPTY_V2_AUTHORING,
    })
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

  /** Update only the transient user form for a clean V2 workspace. */
  public updateInitialization(patch: Partial<NovelV2WorkspaceInitializationDraft>): void {
    if (this.#state.status !== 'not-initialized' || this.#state.initialization.phase === 'submitting') return
    this.#set({
      ...this.#state,
      initialization: initializationState({ ...this.#state.initialization.draft, ...patch }),
    })
  }

  /** Update only the local natural-language request for a later model proposal. */
  public updateDraftBrief(brief: string): void {
    if (this.#state.status !== 'ready' || this.#authoringBusy()) return
    const authoring = { ...this.#state.authoring, brief, phase: 'editing' as const, message: undefined }
    this.#cacheAuthoringDraft(authoring)
    this.#set({
      ...this.#state,
      authoring,
    })
  }

  /**
   * Select a local authoring stage without sending a prompt or mutating the authoritative project.
   * Local author drafts remain isolated by their stage and optional chapter for this browser session.
   */
  public prepareAuthoring(stage: NovelV2AuthoringStage, requestedChapter?: number): void {
    if (this.#state.status !== 'ready' || this.#authoringBusy()) return
    const chapter = this.#authoringChapter(stage, requestedChapter)
    this.#cacheAuthoringDraft(this.#state.authoring)
    const draft = this.#authoringDrafts.get(authoringDraftKey(stage, chapter))
    this.#set({
      ...this.#state,
      authoring: {
        ...this.#state.authoring,
        stage,
        chapter,
        brief: draft?.brief ?? '',
        input: draft?.input,
        pendingProposalItem: draft?.pendingProposalItem,
        phase: 'editing',
        message: undefined,
      },
    })
  }

  /** Ask the selected Session to draft one stage-specific non-authoritative proposal. */
  public startDraft(stage: NovelV2AuthoringStage, chapter?: number): Promise<void> {
    return this.#submitAuthoring(stage, 'ai-draft', chapter)
  }

  /**
   * Report why an authoring action is currently unavailable without changing local or authoritative state.
   * Views use this to disable the corresponding control and expose the same reason as the eventual action.
   */
  public authoringBlocker(
    stage: NovelV2AuthoringStage,
    requestedChapter?: number,
    replacingPendingDraft = false,
  ): string | undefined {
    if (this.#disposed) return '小说工作台已关闭，暂时不能创建新的创作建议。'
    if (this.#state.status !== 'ready') return '当前没有可供创作的小说内容。'
    if (this.#authoringBusy()) return '创作请求仍在处理中；完成后会更新建议列表。'
    const chapter = this.#authoringChapter(stage, requestedChapter)
    const eligibility = this.#authoringEligibility(stage, chapter, replacingPendingDraft)
    if (eligibility !== undefined) return eligibility
    if (this.#sessionId === undefined) return '当前没有可用于创作的会话。'
    if (this.port.prompt === undefined) return '当前会话暂时无法接收创作请求。'
    return undefined
  }

  /** Keep one typed human input locally for a later re-proposal. */
  public updateAuthoringInput(input: NovelV2AuthoringInput): void {
    if (this.#state.status !== 'ready' || this.#authoringBusy()) return
    const authoring = { ...this.#state.authoring, input, phase: 'editing' as const, message: undefined }
    this.#cacheAuthoringDraft(authoring)
    this.#set({
      ...this.#state,
      authoring,
    })
  }

  /** Ask the selected Session to turn the complete local human edit into one new proposal. */
  public reproposeManualDraft(): Promise<void> {
    if (this.#state.status !== 'ready') return Promise.resolve()
    const input = this.#state.authoring.input
    if (!v2AuthoringInputHasValue(input)) return this.#authoringUnavailable('请先填写完整的人工修改内容。')
    if (input?.kind === 'prose') {
      if (this.#state.authoring.stage === 'draft') {
        const chapter = this.#authoringChapter('draft', this.#state.authoring.chapter)
        if (chapter === undefined) return this.#authoringUnavailable('请先选择要重新提交的章节初稿。')
        if (this.#state.authoring.pendingProposalItem !== undefined) return this.#replacePendingDraftProposal(chapter)
        return this.#submitAuthoring('draft', 'manual-reproposal', chapter)
      }
      const artifact = this.#state.workspace.snapshot.artifacts.find(item => item.artifactId === this.#state.authoring.selectedArtifactId)
      if (!isProseArtifact(artifact)) {
        return this.#authoringUnavailable('请先选择本章的初稿或修订稿，再提交人工修订。')
      }
      return this.#submitAuthoring('revision', 'manual-reproposal', artifact.chapter)
    }
    if (input?.kind === 'structured') return this.#submitAuthoring(input.stage, 'manual-reproposal', input.chapter)
    return this.#authoringUnavailable('请先选择要重新提案的创作阶段。')
  }

  /** Select a prose artifact from the authoritative snapshot as a revision parent. */
  public selectArtifact(artifactId: string | undefined): void {
    if (this.#state.status !== 'ready' || this.#authoringBusy()) return
    if (artifactId === undefined) {
      this.#set({
        ...this.#state,
        authoring: { ...this.#state.authoring, selectedArtifactId: undefined, phase: 'editing', message: undefined },
      })
      return
    }
    const artifact = this.#state.workspace.snapshot.artifacts.find(item => item.artifactId === artifactId)
    if (!isProseArtifact(artifact)) {
      void this.#authoringUnavailable('所选修订正文不在当前权威快照中，或它不是可修订的初稿/修订稿。')
      return
    }
    this.#set({
      ...this.#state,
      authoring: {
        ...this.#state.authoring,
        stage: 'revision',
        chapter: artifact.chapter,
        selectedArtifactId: artifact.artifactId,
        selectedFinalArtifactId: undefined,
        pendingProposalItem: undefined,
        input: { kind: 'prose', content: artifact.content ?? '' },
        phase: 'editing', message: undefined,
      },
    })
  }

  /** Select a prose artifact from the authoritative snapshot as the desired final pointer. */
  public selectFinal(artifactId: string | undefined): void {
    if (this.#state.status !== 'ready' || this.#authoringBusy()) return
    if (artifactId === undefined) {
      this.#set({
        ...this.#state,
        authoring: { ...this.#state.authoring, selectedFinalArtifactId: undefined, phase: 'editing', message: undefined },
      })
      return
    }
    const artifact = this.#state.workspace.snapshot.artifacts.find(item => item.artifactId === artifactId)
    if (!isProseArtifact(artifact)) {
      void this.#authoringUnavailable('所选定稿正文不在当前权威快照中，或它不是可选择定稿的初稿/修订稿。')
      return
    }
    this.#set({
      ...this.#state,
      authoring: {
        ...this.#state.authoring,
        stage: 'select-final',
        chapter: artifact.chapter,
        selectedFinalArtifactId: artifact.artifactId,
        pendingProposalItem: undefined,
        input: undefined,
        phase: 'editing', message: undefined,
      },
    })
  }

  /** Submit the closed path-free initialization request exactly once while it is in flight. */
  public initializeWorkspace(): Promise<void> {
    if (this.#disposed || this.#state.status !== 'not-initialized') return Promise.resolve()
    if (this.#activeInitialization !== undefined) return Promise.resolve()
    const workspaceId = this.#workspaceId
    if (workspaceId === undefined) return Promise.resolve()
    const draft = this.#state.initialization.draft
    const validation = initializationValidationMessage(draft)
    if (validation !== undefined) {
      this.#set({ ...this.#state, initialization: initializationState(draft, 'error', validation) })
      return Promise.resolve()
    }
    const initialize = this.port.initializeWorkspace
    if (initialize === undefined) {
      this.#set({ ...this.#state, initialization: initializationState(draft, 'error', '当前无法创建项目。') })
      return Promise.resolve()
    }
    const abort = new AbortController()
    this.#activeInitialization = abort
    const request = ++this.#initializationRequest
    this.#set({ ...this.#state, initialization: initializationState(draft, 'submitting') })
    const pending = startRead(() => initialize(workspaceId, draft, abort.signal)).then(async () => {
      if (!this.#isCurrentWorkspaceInitialization(abort, request, workspaceId)) return
      await this.refresh()
    }).catch(async error => {
      if (!this.#isCurrentWorkspaceInitialization(abort, request, workspaceId)) return
      try {
        const current = await this.#readWorkspaceState(workspaceId, abort.signal)
        if (!this.#isCurrentWorkspaceInitialization(abort, request, workspaceId)) return
        if (current.status === 'ready') {
          await this.refresh()
          return
        }
      } catch {
        // Preserve the initialization failure below; runtime read failures are not product-state sentinels.
      }
      if (!this.#isCurrentWorkspaceInitialization(abort, request, workspaceId)) return
      this.#set({
        status: 'not-initialized', open: this.#state.open, workspace: undefined,
        proposals: EMPTY_PROPOSALS, tasks: EMPTY_TASKS, chapters: EMPTY_CHAPTERS, authoring: EMPTY_V2_AUTHORING,
        initialization: initializationState(draft, 'error', messageOf(error)),
      })
    }).finally(() => {
      if (this.#activeInitialization === abort) this.#activeInitialization = undefined
    })
    this.#track(pending)
    return pending
  }

  /** Refresh the current workspace state and its proposal queue through existing loopback reads. */
  public refresh(): Promise<void> { return this.#refresh(true, false) }

  /**
   * Re-read only the Host-authoritative V2 snapshot and persisted Proposal queue after Session activity.
   * Model text is deliberately opaque: this controller neither reads nor parses it.
   */
  public refreshAfterSessionActivity(): Promise<void> { return this.#refresh(false, true) }

  #refresh(loadChapterContext: boolean, settlesAuthoring: boolean): Promise<void> {
    const workspaceId = this.#workspaceId
    if (this.#disposed || workspaceId === undefined) return Promise.resolve()
    const previous = this.#state.status === 'ready' ? this.#state : this.#retainedReady
    const existingInitialization = this.#state.status === 'not-initialized' ? this.#state.initialization : undefined
    this.#active?.abort()
    this.#cancelChapterContextRead()
    this.#cancelTaskRead()
    const abort = new AbortController()
    this.#active = abort
    const request = ++this.#request
    this.#set({
      status: 'loading', open: this.#state.open, workspace: undefined,
      proposals: { ...this.#state.proposals, phase: 'loading', message: undefined },
      tasks: this.#state.tasks, chapters: this.#state.chapters, authoring: this.#state.authoring,
    })
    // Older isolated controller ports did not expose the clean-workspace union. Keep their
    // historical all-settled lifecycle while the installed V2 port always sequences state first.
    const legacyProposalRead = this.port.readWorkspaceState === undefined
      ? startRead(() => this.port.listProposals(workspaceId, abort.signal))
      : undefined
    const pending = startRead(() => this.#readWorkspaceState(workspaceId, abort.signal)).then(workspaceState => {
      if (abort.signal.aborted || request !== this.#request || workspaceId !== this.#workspaceId) return
      if (workspaceState.status === 'not-initialized') {
        this.#set({
          status: 'not-initialized', open: this.#state.open, workspace: undefined,
          proposals: EMPTY_PROPOSALS, tasks: EMPTY_TASKS, chapters: EMPTY_CHAPTERS, authoring: EMPTY_V2_AUTHORING,
          initialization: existingInitialization ?? initializationState(),
        })
        return
      }
      const state = workspaceState.state
      return (legacyProposalRead ?? startRead(() => this.port.listProposals(workspaceId, abort.signal))).then(proposals => {
        if (abort.signal.aborted || request !== this.#request || workspaceId !== this.#workspaceId) return
      const newlyRecordedAuthoringProposal = settlesAuthoring
        && (previous?.authoring.phase === 'submitted' || previous?.authoring.phase === 'reconciling')
        ? proposals.find(candidate => candidate.items.some(item => item.status === 'pending')
          && !previous?.proposals.items.some(item => item.proposalId === candidate.proposalId))
        : undefined
      const selectedProposal = newlyRecordedAuthoringProposal?.proposalId
        ?? (proposals.some(proposal => proposal.proposalId === previous?.proposals.selectedId)
          ? previous?.proposals.selectedId
          : proposals[0]?.proposalId)
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
      const previousChapter = previous?.chapters.selected
      const selectedChapter = isPlannedChapterNumber(previousChapter, state.project.plannedChapters)
        ? previousChapter
        : state.chapters[0]?.chapter
      const selectedChapterPersisted = selectedChapter !== undefined
        && state.chapters.some(chapter => chapter.chapter === selectedChapter)
      this.#set({
        status: 'ready', open: this.#state.open,
        workspace: {
          workspaceId, project: state.project, globalRevision: state.globalRevision, readOnly: state.readOnly, snapshot: state,
        },
        proposals: {
          phase: 'ready', items: proposals, selectedId: selectedProposal, selectedChange, message: undefined,
        },
        tasks: { items: state.tasks, selectedId: selectedTask, message: undefined },
        chapters: {
          selected: selectedChapter,
          items: state.chapters,
          context: selectedChapter !== undefined && !selectedChapterPersisted
            ? { phase: 'idle', chapter: selectedChapter, previousFinal: undefined, message: undefined }
            : undefined,
        },
        authoring: this.#authoringAfterRefresh(
          previous?.authoring,
          state,
          proposals,
          settlesAuthoring,
          newlyRecordedAuthoringProposal,
        ),
      })
      if (loadChapterContext && selectedChapterPersisted && selectedChapter !== undefined) void this.#readChapterContext(selectedChapter)
      })
    }).catch(async error => {
      if (legacyProposalRead !== undefined) await legacyProposalRead.catch(() => {})
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
        tasks: EMPTY_TASKS, chapters: EMPTY_CHAPTERS, authoring: this.#state.authoring, message: messageOf(error),
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

  /** Select one persisted Proposal item for its queue-local, read-only review. */
  public openProposalChange(index: number): void {
    if (this.#state.status !== 'ready') return
    const proposal = this.#state.proposals.items.find(item => item.proposalId === this.#state.proposals.selectedId)
    if (proposal === undefined) return
    if (proposal.items[index] === undefined) return
    this.#set({ ...this.#state, proposals: { ...this.#state.proposals, selectedChange: index } })
  }

  /** Ask the Host to apply the selected Proposal Bundle in its persisted item order. */
  public applySelectedProposal(): Promise<void> {
    if (this.#state.status !== 'ready') return Promise.resolve()
    const proposal = this.#state.proposals.items.find(item => item.proposalId === this.#state.proposals.selectedId)
    if (proposal === undefined) return Promise.resolve()
    if (proposal.status === 'stale') {
      return this.#proposalOperationUnavailable('这项创作建议与当前内容不一致；请先处理冲突后再应用。')
    }
    const workspaceId = this.#state.workspace.workspaceId
    const apply = this.port.applyProposal
    if (apply === undefined) return this.#proposalOperationUnavailable('当前无法应用这项创作建议。')
    const authoring = this.#state.authoring
    const draftToClear: LocalAuthoringTarget | undefined = authoring.stage === undefined
      ? undefined
      : { stage: authoring.stage, chapter: authoring.chapter }
    return this.#runProposalOperation(
      proposal.proposalId,
      '提案应用',
      signal => apply(workspaceId, proposal.proposalId, signal),
      draftToClear,
    )
  }

  /** Ask the Host to retry one failed Proposal Bundle item by opaque item identity. */
  public retryProposalItem(index: number): Promise<void> {
    if (this.#state.status !== 'ready') return Promise.resolve()
    const proposal = this.#state.proposals.items.find(item => item.proposalId === this.#state.proposals.selectedId)
    const item = proposal?.items[index]
    if (proposal === undefined || item === undefined) return Promise.resolve()
    const workspaceId = this.#state.workspace.workspaceId
    const retry = this.port.retryProposalItem
    if (retry === undefined) return this.#proposalOperationUnavailable('当前无法重试这项创作建议。')
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
    if (discard === undefined) return this.#proposalOperationUnavailable('当前无法放弃这项创作建议。')
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
    if (regenerate === undefined) return this.#proposalOperationUnavailable('当前无法重新生成这项创作建议。')
    return this.#runProposalOperation(proposal.proposalId, '提案项重新生成', signal => regenerate(workspaceId, proposal.proposalId, item.itemId, signal))
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
    if (!isPlannedChapterNumber(chapter, this.#state.workspace.project.plannedChapters)) return
    const persisted = this.#state.workspace.snapshot.chapters.some(item => item.chapter === chapter)
    this.#cancelChapterContextRead()
    this.#set({
      ...this.#state,
      chapters: {
        ...this.#state.chapters,
        selected: chapter,
        context: persisted
          ? this.#state.chapters.context
          : { phase: 'idle', chapter, previousFinal: undefined, message: undefined },
      },
    })
    if (persisted) void this.#readChapterContext(chapter)
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

  /** Await every currently in-flight Host read, including superseded requests that still need to settle. */
  public async whenIdle(): Promise<void> { await this.#settleInflight() }

  /** Move an admitted, correlated authoring turn into local reconciliation; it never parses model text. */
  public authoringTurnSettled(): void {
    if (this.#disposed || this.#state.status !== 'ready') return
    if (this.#state.authoring.phase !== 'submitting' && this.#state.authoring.phase !== 'submitted') return
    this.#set({
      ...this.#state,
      authoring: {
        ...this.#state.authoring,
        phase: 'reconciling',
        message: '模型轮次已结束，正在通过权威快照与 Proposal 队列确认结果。',
      },
    })
  }

  /** @returns The exact readable request still awaiting its Session turn; it is neither persisted nor a model result. */
  public currentAuthoringRequestText(): string | undefined {
    if (this.#disposed) return undefined
    const active = this.#state.authoring.phase === 'submitting'
      || this.#state.authoring.phase === 'submitted'
      || this.#state.authoring.phase === 'reconciling'
    return active ? this.#authoringCorrelationText : undefined
  }

  /** Mark a vanished queued prompt as failed locally; no authoring or project data is persisted here. */
  public authoringPromptLost(): void {
    if (this.#disposed || this.#state.status !== 'ready' || !this.#authoringBusy()) return
    this.#authoringRequest += 1
    this.#authoringCorrelationText = undefined
    this.#set({
      ...this.#state,
      authoring: {
        ...this.#state.authoring,
        phase: 'error',
        message: '创作请求没有送达当前会话，尚未形成新的创作建议；可以重试。',
      },
    })
  }

  /** Stop active V2 reads when the Host disconnects and keep the last ready selection only for a later reconnect. */
  public disconnected(): void {
    const authoring = retryableAuthoringAfterDisconnect(this.#state.authoring)
    if (this.#state.status === 'ready') {
      this.#retainedReady = { ...this.#state, authoring }
    } else if (this.#retainedReady !== undefined) {
      this.#retainedReady = {
        ...this.#retainedReady,
        authoring: retryableAuthoringAfterDisconnect(this.#retainedReady.authoring),
      }
    }
    this.#request += 1
    this.#active?.abort()
    this.#active = undefined
    this.#cancelChapterContextRead()
    this.#cancelTaskRead()
    this.#cancelProposalOperation()
    this.#cancelWorkspaceInitialization()
    this.#authoringRequest += 1
    this.#authoringCorrelationText = undefined
    this.#set({
      status: 'error', open: this.#state.open, workspace: undefined,
      proposals: { ...EMPTY_PROPOSALS, phase: 'failed', message: 'Harness 连接已断开，恢复连接后重新读取。' },
      tasks: EMPTY_TASKS, chapters: EMPTY_CHAPTERS, authoring,
      message: 'Harness 连接已断开，恢复连接后重新读取。',
    })
  }

  /** Abort outstanding loopback reads and release render subscribers on client unload. */
  public dispose(): Promise<void> {
    if (this.#disposePromise !== undefined) return this.#disposePromise
    this.#disposed = true
    this.#request += 1
    this.#active?.abort()
    this.#authoringRequest += 1
    this.#authoringCorrelationText = undefined
    this.#cancelChapterContextRead()
    this.#cancelTaskRead()
    this.#cancelProposalOperation()
    this.#cancelWorkspaceInitialization()
    this.#retainedReady = undefined
    this.#disposePromise = this.#settleInflight().then(() => { this.#listeners.clear() })
    return this.#disposePromise
  }

  #submitAuthoring(
    stage: NovelV2AuthoringStage,
    mode: 'ai-draft' | 'manual-reproposal',
    requestedChapter: number | undefined,
  ): Promise<void> {
    if (this.#disposed || this.#state.status !== 'ready') return Promise.resolve()
    if (this.#authoringBusy()) {
      this.#set({
        ...this.#state,
        authoring: { ...this.#state.authoring, message: '创作请求仍在处理中；完成后会更新建议列表。' },
      })
      return Promise.resolve()
    }
    const chapter = this.#authoringChapter(stage, requestedChapter)
    const blocker = this.authoringBlocker(stage, chapter)
    if (blocker !== undefined) return this.#authoringUnavailable(blocker)
    const sessionId = this.#sessionId
    const prompt = this.port.prompt
    if (sessionId === undefined) return this.#authoringUnavailable('当前没有可用于创作的会话。')
    if (prompt === undefined) return this.#authoringUnavailable('当前会话暂时无法接收创作请求。')
    const authoring = {
      ...this.#state.authoring,
      stage,
      chapter,
    }
    const text = v2AuthoringPrompt({
      stage,
      mode,
      requestNumber: this.#authoringActionNumber + 1,
      brief: authoring.brief,
      input: authoring.input,
      chapter,
      selectedVersion: this.#selectedAuthoringVersion(stage, authoring),
    })
    if (this.port.hasQueuedAuthoringRequest?.(sessionId, text) === true) {
      return this.#authoringUnavailable(V2_DUPLICATE_QUEUED_AUTHORING_REQUEST_MESSAGE)
    }
    const workspaceId = this.#state.workspace.workspaceId
    const request = ++this.#authoringRequest
    this.#authoringActionNumber += 1
    const submittingAuthoring = {
      ...authoring,
      phase: 'submitting' as const,
      message: undefined,
    }
    this.#authoringCorrelationText = text
    this.#set({ ...this.#state, authoring: submittingAuthoring })
    const pending = Promise.resolve().then(() => prompt(sessionId, text)).then(result => {
      if (!this.#isCurrentAuthoring(request, workspaceId, sessionId)) return
      if (result.ok) {
        this.#set({
          ...this.#state,
          authoring: {
            ...this.#state.authoring,
            phase: 'submitted',
            message: '创作请求已提交；完成后会更新建议列表。',
          },
        })
        return
      }
      this.#set({
        ...this.#state,
        authoring: { ...this.#state.authoring, phase: 'error', message: `会话提示失败：${result.error.code}: ${result.error.message}` },
      })
      this.#authoringCorrelationText = undefined
    }).catch(error => {
      if (!this.#isCurrentAuthoring(request, workspaceId, sessionId)) return
      this.#set({
        ...this.#state,
        authoring: { ...this.#state.authoring, phase: 'error', message: `会话提示失败：${messageOf(error)}` },
      })
      this.#authoringCorrelationText = undefined
    })
    this.#track(pending)
    return pending
  }

  /** Replace one locally identified pending draft only after the Host has discarded that exact item. */
  #replacePendingDraftProposal(chapter: number): Promise<void> {
    if (this.#state.status !== 'ready') return Promise.resolve()
    const blocker = this.authoringBlocker('draft', chapter, true)
    if (blocker !== undefined) return this.#authoringUnavailable(blocker)
    const target = this.#pendingDraftReplacementTarget(chapter)
    if (target === undefined) return this.#authoringUnavailable('待审核初稿已变化；请刷新建议列表后再试。')
    const discard = this.port.discardProposalItem
    if (discard === undefined) return this.#authoringUnavailable('当前无法放弃待审核初稿以提交人工修改。')
    const sessionId = this.#sessionId
    if (sessionId === undefined) return this.#authoringUnavailable('当前没有可用于创作的会话。')
    if (this.#activeProposal !== undefined) return this.#authoringUnavailable('正在处理另一项创作建议。')
    const workspaceId = this.#state.workspace.workspaceId
    const request = ++this.#authoringRequest
    const abort = new AbortController()
    this.#activeProposal = abort
    this.#set({
      ...this.#state,
      authoring: { ...this.#state.authoring, phase: 'submitting', message: '正在替换待审核初稿。' },
    })
    const pending = Promise.resolve().then(() => discard(workspaceId, target.proposalId, target.itemId, abort.signal))
      .then(async () => {
        if (abort.signal.aborted || !this.#isCurrentAuthoring(request, workspaceId, sessionId)) return
        await this.refresh()
        if (abort.signal.aborted || !this.#isCurrentAuthoring(request, workspaceId, sessionId) || this.#state.status !== 'ready') return
        const authoring = {
          ...this.#state.authoring,
          pendingProposalItem: undefined,
          phase: 'editing' as const,
          message: undefined,
        }
        this.#cacheAuthoringDraft(authoring)
        this.#set({ ...this.#state, authoring })
        await this.#submitAuthoring('draft', 'manual-reproposal', chapter)
      }).catch(error => {
        if (abort.signal.aborted || !this.#isCurrentAuthoring(request, workspaceId, sessionId)) return
        this.#set({
          ...this.#state,
          authoring: {
            ...this.#state.authoring,
            phase: 'error',
            message: `替换待审核初稿失败：${messageOf(error)}`,
          },
        })
      }).finally(() => {
        if (this.#activeProposal === abort) this.#activeProposal = undefined
      })
    this.#track(pending)
    return pending
  }

  #authoringChapter(stage: NovelV2AuthoringStage, requested: number | undefined): number | undefined {
    if (stage !== 'chapter-blueprint' && stage !== 'draft' && stage !== 'revision' && stage !== 'select-final') return undefined
    return requested ?? this.#state.authoring.chapter ?? this.#state.chapters.selected ?? 1
  }

  /** Describe the selected prose from this authoritative snapshot without sending its opaque identity to the Session. */
  #selectedAuthoringVersion(
    stage: NovelV2AuthoringStage,
    authoring: NovelV2AuthoringState,
  ): { readonly ordinal: number; readonly label: string } | undefined {
    if (this.#state.status !== 'ready') return undefined
    const selectedArtifactId = stage === 'revision'
      ? authoring.selectedArtifactId
      : stage === 'select-final' ? authoring.selectedFinalArtifactId : undefined
    if (selectedArtifactId === undefined) return undefined
    const versions = this.#state.workspace.snapshot.artifacts.filter(isProseArtifact)
    const index = versions.findIndex(artifact => artifact.artifactId === selectedArtifactId)
    if (index < 0) return undefined
    const selected = versions[index]!
    return {
      ordinal: index + 1,
      label: `第 ${selected.chapter} 章${selected.kind === 'draft' ? '初稿' : '修订稿'}`,
    }
  }

  #authoringEligibility(
    stage: NovelV2AuthoringStage,
    chapter: number | undefined,
    replacingPendingDraft = false,
  ): string | undefined {
    if (this.#state.status !== 'ready') return '当前没有可供创作的小说内容。'
    if (this.#state.workspace.readOnly) return '当前项目为只读，不能创建新的创作建议。'
    const pendingItems = this.#state.proposals.items.flatMap(proposal => proposal.items
      .filter(item => item.status === 'pending')
      .map(item => ({ proposalId: proposal.proposalId, item })))
    const pendingDraftTarget = replacingPendingDraft && stage === 'draft' && chapter !== undefined
      ? this.#pendingDraftReplacementTarget(chapter)
      : undefined
    if (pendingItems.length > 0 && (!replacingPendingDraft
      || stage !== 'draft'
      || pendingDraftTarget === undefined
      || pendingItems.length !== 1)) {
      return '已有待审核建议；请先审核、应用、放弃或等待它完成后再创建新的建议。'
    }
    if (stage !== 'project-refine' && this.#state.workspace.project.revision === 0) {
      return '请先创建并应用项目设置优化建议，再开始故事架构创作。'
    }
    const chapterStage = stage === 'chapter-blueprint' || stage === 'draft' || stage === 'revision' || stage === 'select-final'
    if (stage === 'characters' && !hasMeaningfulArchitecture(this.#state.workspace.snapshot)) {
      return '请先完成故事架构，再创建人物设定建议。'
    }
    if (stage === 'outline') {
      if (!hasMeaningfulArchitecture(this.#state.workspace.snapshot)) {
        return '请先完成故事架构，再创建全书大纲建议。'
      }
      if (this.#state.workspace.snapshot.characters.items.length === 0) {
        return '请先完成至少一个人物设定，再创建全书大纲建议。'
      }
    }
    if (!chapterStage) return undefined
    if (!isPlannedChapterNumber(chapter, this.#state.workspace.project.plannedChapters)) {
      return '章节号必须是当前项目计划范围内的正整数。'
    }
    const snapshot = this.#state.workspace.snapshot
    if (stage === 'chapter-blueprint' && snapshot.architecture.plotOutline.trim() === '') {
      return '请先完成全书大纲，再创建章节蓝图。'
    }
    if (stage === 'chapter-blueprint' && chapter > 1 && !snapshot.chapterFinals.some(item => item.chapter === chapter - 1)) {
      return '请先让上一章的定稿选择进入权威快照，再创建本章蓝图以保持连续性。'
    }
    if (stage === 'draft' && !snapshot.chapters.some(item => item.chapter === chapter)) {
      return '请先让该章节蓝图进入权威快照，再生成章节初稿。'
    }
    if (stage === 'draft' && chapter > 1 && !snapshot.chapterFinals.some(item => item.chapter === chapter - 1)) {
      return '请先让上一章的定稿选择进入权威快照，再生成本章初稿以保持连续性。'
    }
    if (stage === 'revision') {
      const artifact = snapshot.artifacts.find(item => item.artifactId === this.#state.authoring.selectedArtifactId)
      if (!isProseArtifact(artifact) || artifact.chapter !== chapter) return '请先选择当前章节的初稿或修订稿作为修订来源。'
    }
    if (stage === 'select-final') {
      const artifact = snapshot.artifacts.find(item => item.artifactId === this.#state.authoring.selectedFinalArtifactId)
      if (!isProseArtifact(artifact) || artifact.chapter !== chapter) return '请先选择当前章节的初稿或修订稿作为定稿候选。'
    }
    return undefined
  }

  /** Find the one durable inbox item hydrated into the active local draft; UI selection never participates. */
  #pendingDraftReplacementTarget(chapter: number): NovelV2AuthoringState['pendingProposalItem'] {
    if (this.#state.status !== 'ready') return undefined
    const authoring = this.#state.authoring
    if (authoring.stage !== 'draft' || authoring.chapter !== chapter || authoring.input?.kind !== 'prose') return undefined
    const target = authoring.pendingProposalItem
    if (target === undefined) return undefined
    const proposal = this.#state.proposals.items.find(candidate => candidate.proposalId === target.proposalId)
    const item = proposal?.items.find(candidate => candidate.itemId === target.itemId)
    if (item?.status !== 'pending' || !isDraftProposalChange(item.change) || item.change.chapter !== chapter) return undefined
    return target
  }

  #authoringUnavailable(message: string): Promise<void> {
    if (this.#state.status === 'ready') {
      this.#set({ ...this.#state, authoring: { ...this.#state.authoring, phase: 'error', message } })
    }
    return Promise.resolve()
  }

  #authoringAfterRefresh(
    previous: NovelV2AuthoringState | undefined,
    snapshot: NovelStateReadResult,
    proposals: readonly NovelProposalSummary[],
    settlesAuthoring: boolean,
    newlyRecordedProposal: NovelProposalSummary | undefined,
  ): NovelV2AuthoringState {
    if (previous === undefined) return EMPTY_V2_AUTHORING
    const selectedArtifact = snapshot.artifacts.find(item => item.artifactId === previous.selectedArtifactId)
    const selectedFinal = snapshot.artifacts.find(item => item.artifactId === previous.selectedFinalArtifactId)
    const selectedArtifactId = isProseArtifact(selectedArtifact) ? selectedArtifact.artifactId : undefined
    const selectedFinalArtifactId = isProseArtifact(selectedFinal) ? selectedFinal.artifactId : undefined
    // The active stage may have selected a later chapter while an earlier prose selection
    // remains available for a future revision. Preserve the explicit stage target first.
    const chapter = previous.chapter ?? selectedArtifact?.chapter ?? selectedFinal?.chapter
    if (!settlesAuthoring || (previous.phase !== 'submitted' && previous.phase !== 'reconciling')) {
      return { ...previous, chapter, selectedArtifactId, selectedFinalArtifactId }
    }
    this.#authoringCorrelationText = undefined
    const proposalRecorded = proposals.some(proposal => proposal.items.some(item => item.status === 'pending'))
    const stage = previous.stage
    const hydration = stage === undefined
      ? undefined
      : newlyRecordedProposal?.items
        .filter(item => item.status === 'pending')
        .map(item => {
          const input = authoringInputFromProposal(stage, chapter, item.change, snapshot)
          if (input === undefined) return undefined
          return {
            input,
            pendingProposalItem: stage === 'draft' && isDraftProposalChange(item.change)
              ? { proposalId: newlyRecordedProposal.proposalId, itemId: item.itemId }
              : undefined,
          }
        })
        .find(candidate => candidate !== undefined)
    const input = hydration?.input
    const hydrated = input !== undefined
    const authoring = {
      ...previous,
      chapter,
      selectedArtifactId,
      selectedFinalArtifactId,
      pendingProposalItem: hydration?.pendingProposalItem,
      ...(input === undefined ? {} : { input }),
      phase: hydrated ? 'editing' as const : 'idle' as const,
      message: hydrated
        ? 'AI 生成的待审核建议已填入本地草稿；它尚未应用，请在建议队列审核后再应用。'
        : proposalRecorded
        ? '已更新建议列表；新的创作建议等待审核。'
        : '已更新建议列表；暂未发现新的创作建议。',
    }
    if (hydrated) this.#cacheAuthoringDraft(authoring)
    return authoring
  }

  #isCurrentAuthoring(request: number, workspaceId: WorkspaceId, sessionId: SessionId): boolean {
    return !this.#disposed
      && request === this.#authoringRequest
      && sessionId === this.#sessionId
      && this.#state.status === 'ready'
      && workspaceId === this.#state.workspace.workspaceId
  }

  #authoringBusy(): boolean {
    if (this.#state.status !== 'ready') return false
    return v2AuthoringBusy(this.#state.authoring.phase)
  }

  /** Cache only the selected local form; this is never a Proposal or Host write. */
  #cacheAuthoringDraft(authoring: NovelV2AuthoringState): void {
    if (authoring.stage === undefined) return
    this.#authoringDrafts.set(authoringDraftKey(authoring.stage, authoring.chapter), {
      brief: authoring.brief,
      input: authoring.input,
      pendingProposalItem: authoring.pendingProposalItem,
    })
  }

  /** Drop one applied target's local values so the form falls back to the refreshed authoritative snapshot. */
  #clearAuthoringDraft(target: LocalAuthoringTarget): void {
    this.#authoringDrafts.delete(authoringDraftKey(target.stage, target.chapter))
    if (this.#state.status !== 'ready') return
    const authoring = this.#state.authoring
    if (authoring.stage !== target.stage || authoring.chapter !== target.chapter) return
    this.#set({
      ...this.#state,
      authoring: { ...authoring, brief: '', input: undefined, pendingProposalItem: undefined },
    })
  }

  #proposalOperationUnavailable(message: string): Promise<void> {
    this.#setProposalMessage(message)
    return Promise.resolve()
  }

  #runProposalOperation(
    proposalId: string,
    label: string,
    operation: (signal: AbortSignal) => Promise<unknown>,
    draftToClear: LocalAuthoringTarget | undefined = undefined,
  ): Promise<void> {
    if (this.#state.status !== 'ready') return Promise.resolve()
    if (this.#state.workspace.readOnly) {
      this.#setProposalMessage('当前项目为只读，不能修改创作建议。')
      return Promise.resolve()
    }
    if (this.#activeProposal !== undefined) {
      this.#setProposalMessage('正在处理这项创作建议。')
      return Promise.resolve()
    }
    const workspaceId = this.#state.workspace.workspaceId
    const request = ++this.#proposalRequest
    const abort = new AbortController()
    this.#activeProposal = abort
    const pending = Promise.resolve().then(() => operation(abort.signal)).then(async () => {
      if (!this.#isCurrentProposalMutation(abort, request, workspaceId)) return
      await this.refresh()
      if (!this.#isCurrentProposalMutation(abort, request, workspaceId)) return
      if (draftToClear !== undefined) this.#clearAuthoringDraft(draftToClear)
      if (!this.#isCurrentProposalOperation(abort, request, workspaceId, proposalId)) return
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

  #readWorkspaceState(workspaceId: WorkspaceId, signal: AbortSignal): Promise<NovelV2WorkspaceStateReadResult> {
    if (this.port.readWorkspaceState !== undefined) return this.port.readWorkspaceState(workspaceId, signal)
    if (this.port.readState === undefined) return Promise.reject(new Error('当前无法读取小说内容。'))
    return this.port.readState(workspaceId, signal).then(state => ({ status: 'ready', workspaceId, state }))
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

  #cancelWorkspaceInitialization(): void {
    this.#initializationRequest += 1
    this.#activeInitialization?.abort()
    this.#activeInitialization = undefined
  }

  #isCurrentWorkspaceInitialization(
    abort: AbortController,
    request: number,
    workspaceId: WorkspaceId,
  ): boolean {
    return !this.#disposed && !abort.signal.aborted
      && request === this.#initializationRequest
      && workspaceId === this.#workspaceId
      && this.#state.status === 'not-initialized'
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
