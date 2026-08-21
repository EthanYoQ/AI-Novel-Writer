/** Framework-independent state and orchestration for the compact novel workbench. */

import type { SessionId, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type { NovelAssetReadWireResult, NovelContextReadResult, NovelContextReady } from '../context-types.ts'
import type { CreativeStrategy, NovelProjectId, Revision } from '../types.ts'
import {
  assetProposalPrompt,
  parseCharacters,
  parseChapterBlueprint,
  parseProjectManifest,
  parseStoryBlueprint,
  projectDraft,
  sameCharacters,
  serializeCharacters,
  serializeChapterBlueprint,
  serializeChapterDraft,
  serializeProject,
  serializeStoryBlueprint,
  visibleCharacterIds,
  type NovelCharacterDraft,
  type NovelChapterBlueprintDraft,
  type NovelChapterBlueprintEditorScreen,
  type NovelChapterDraftEditorScreen,
  type NovelCharactersEditorScreen,
  type NovelAssetEditorScreen,
  type NovelAssetGenerationState,
  type NovelProjectEditorScreen,
  type NovelProjectSettingsDraft,
  type NovelStoryBlueprintDraft,
  type NovelStoryBlueprintEditorScreen,
  type NovelWorkbenchEditableTarget,
  type NovelWorkbenchScreen,
  type ProjectManifestEditorSource,
} from './asset-editor.ts'

export type {
  NovelAssetChangePreview,
  NovelAssetEditorPhase,
  NovelCharacterDraft,
  NovelChapterBlueprintDraft,
  NovelChapterBlueprintEditorScreen,
  NovelChapterDraftEditorScreen,
  NovelCharactersEditorScreen,
  NovelAssetEditorScreen,
  NovelAssetGenerationState,
  NovelProjectEditorScreen,
  NovelProjectSettingsDraft,
  NovelStoryBlueprintDraft,
  NovelStoryBlueprintEditorScreen,
  NovelWorkbenchEditableTarget,
  NovelWorkbenchScreen,
} from './asset-editor.ts'

export {
  NovelV2WorkbenchController,
} from './workbench-v2.ts'
export type {
  NovelChapterPanelState,
  NovelEditorPanelState,
  NovelProposalPanelState,
  NovelTaskPanelState,
  NovelV2WorkbenchPort,
  NovelV2WorkbenchState,
  NovelWorkspacePanelState,
} from './workbench-v2.ts'

/** Dedicated Preset id expected on a Session that receives novel proposals. */
export const AI_NOVEL_PRESET_ID = 'ai-novel-writer'

function assertNever(value: never): never {
  throw new Error(`Unexpected novel workbench value: ${String(value)}`)
}

function sameAssetTarget(
  left: NovelWorkbenchEditableTarget,
  right: NovelWorkbenchEditableTarget,
): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'chapter-blueprint' || left.kind === 'chapter-draft') {
    return right.kind === left.kind && right.chapter === left.chapter
  }
  return true
}

/** Identity values included verbatim in an initialization proposal. */
export interface NovelInitializationIdentity {
  readonly projectId: NovelProjectId
  readonly createdAt: string
  readonly updatedAt: string
}

/** User-editable initialization fields before numeric validation and proposal generation. */
export interface NovelInitializationDraft {
  readonly title: string
  readonly language: string
  readonly genre: string
  readonly plannedChapters: string
  readonly targetWordsPerChapter: string
  readonly creativeStrategy: CreativeStrategy
}

/** Known native-approval availability for the selected Session. */
export type NovelApprovalAvailability = 'ask' | 'never' | 'unknown'

/** Minimal durable tool outcome needed to distinguish approval rejection from a committed change. */
export interface NovelApplyOutcome {
  readonly isError: boolean
  readonly code: string | undefined
  /** Successful CommitReceipt revision parsed from the durable tool result. */
  readonly newRevision?: Revision
  readonly attribution:
    | { readonly kind: 'initialize'; readonly requestJson: string }
    | {
        readonly kind: 'replace'
        readonly targetKind: string
        readonly chapter?: number
        readonly baseRevision: string
        readonly replacement: string
      }
    | undefined
}

/** Error emitted when the browser has no live Host connection. */
export class NovelWorkbenchDisconnectedError extends Error {
  /** @param cause Optional transport failure. */
  public constructor(cause?: unknown) {
    super('Host connection is unavailable', cause === undefined ? undefined : { cause })
    this.name = 'NovelWorkbenchDisconnectedError'
  }
}

/** Current Workspace and Session selected in the Harness shell. */
export interface NovelWorkbenchTarget {
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
  readonly agentPreset: string | undefined
  readonly approval: NovelApprovalAvailability
}

/** Result returned by the current Session prompt operation. */
export type NovelPromptResult =
  | { readonly ok: true; readonly value: { readonly accepted: true } }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** Closed browser operations required by the workbench controller. */
export interface NovelWorkbenchPort {
  /**
   * @param workspaceId Opaque Workspace registry identity, never a local path.
   * @param chapter Selected one-based chapter number.
   * @param signal Cancellation signal for the Host transport and filesystem reads.
   * @returns Bounded context or an explicit uninitialized result.
   * @throws When transport, response validation, project reading, or cancellation fails.
   */
  read(workspaceId: WorkspaceId, chapter: number, signal: AbortSignal): Promise<NovelContextReadResult>
  /**
   * @param workspaceId Opaque Workspace registry identity, never a local path.
   * @param target Recognized project-owned asset without a filesystem path.
   * @param signal Cancellation signal for the Host transport and filesystem read.
   * @returns Exact normalized asset text and its authoritative revision.
   * @throws When transport, response validation, project reading, or cancellation fails.
   */
  readAsset(
    workspaceId: WorkspaceId,
    target: NovelWorkbenchEditableTarget,
    signal: AbortSignal,
  ): Promise<NovelAssetReadWireResult>
  /**
   * @param sessionId Current dedicated Session identity.
   * @param text Proposal prompt with a deterministic body and unique correlation marker, submitted as an ordinary queued turn.
   * @returns Host admission result; a successful result does not imply approval or persistence.
   */
  prompt(sessionId: SessionId, text: string): Promise<NovelPromptResult>
}

/** Initialization submission phase retained with the editable draft. */
export type NovelInitializationPhase = 'editing' | 'preview' | 'submitting' | 'submitted' | 'error'

/** Exact deterministic values shown before an initialization prompt may be submitted. */
export interface NovelInitializationPreview {
  readonly json: string
  readonly prompt: string
}

/** Complete initialization editor state. */
export interface NovelInitializationState {
  readonly draft: NovelInitializationDraft
  readonly phase: NovelInitializationPhase
  readonly preview?: NovelInitializationPreview
  readonly blocker?: string
  readonly message?: string
  readonly generation?: NovelInitializationGenerationState
}

/** Model-generation state for an uninitialized project. */
export interface NovelInitializationGenerationState {
  readonly brief: string
  readonly phase: 'editing' | 'submitting' | 'submitted' | 'reconciling' | 'error'
  readonly message?: string
  readonly identity?: NovelInitializationIdentity
  readonly expectedRevision?: Revision
}

/** Last user-visible read operation outcome. */
export interface NovelReadFeedback {
  readonly kind: 'loading' | 'success' | 'error' | 'disconnected'
  readonly message: string
}

interface NovelWorkbenchStateBase {
  readonly open: boolean
  readonly readFeedback?: NovelReadFeedback
}

/** Complete render state for the compact workbench. */
export type NovelWorkbenchState =
  | ({ readonly status: 'idle' | 'empty' | 'loading' | 'disconnected' } & NovelWorkbenchStateBase)
  | ({ readonly status: 'not-initialized'; readonly initialization: NovelInitializationState } & NovelWorkbenchStateBase)
  | (NovelContextReady & NovelWorkbenchStateBase & {
      readonly screen: NovelWorkbenchScreen
      readonly submissionBlocker?: string
    })
  | ({ readonly status: 'error'; readonly message: string } & NovelWorkbenchStateBase)

const DEFAULT_INITIALIZATION: NovelInitializationDraft = {
  title: '',
  language: 'zh-CN',
  genre: '',
  plannedChapters: '20',
  targetWordsPerChapter: '3000',
  creativeStrategy: 'auto',
}

function defaultIdentity(): NovelInitializationIdentity {
  const timestamp = new Date().toISOString()
  return {
    projectId: crypto.randomUUID() as NovelProjectId,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label}必须是正整数`)
  return parsed
}

function linesFromDraft(text: string): string[] {
  return text === '' ? [] : text.split('\n')
}

interface ValidatedInitializationFields {
  readonly title: string
  readonly language: string
  readonly genre: string
  readonly plannedChapters: number
  readonly targetWordsPerChapter: number
  readonly creativeStrategy: CreativeStrategy
}

function validateInitializationDraft(draft: NovelInitializationDraft): ValidatedInitializationFields {
  const fields = {
    title: draft.title.trim(),
    language: draft.language.trim(),
    genre: draft.genre.trim(),
    plannedChapters: positiveInteger(draft.plannedChapters, '计划章数'),
    targetWordsPerChapter: positiveInteger(draft.targetWordsPerChapter, '每章目标字数'),
    creativeStrategy: draft.creativeStrategy,
  }
  if (fields.title === '') throw new Error('小说标题不能为空')
  if (fields.language === '') throw new Error('语言不能为空')
  if (fields.genre === '') throw new Error('类型不能为空')
  return fields
}

function initializationProposalJson(
  identity: NovelInitializationIdentity,
  fields: ValidatedInitializationFields,
): string {
  return JSON.stringify({
    kind: 'initialize',
    projectId: identity.projectId,
    createdAt: identity.createdAt,
    updatedAt: identity.updatedAt,
    ...fields,
  }, null, 2)
}

function initializationPromptFromJson(json: string): string {
  return `请初始化当前 Harness 小说项目。

先调用 novel_read，确认项目尚未初始化。然后仅调用一次 novel_apply_change，并把以下 JSON 对象作为浅层参数原样传入；不要嵌套 request，不要改写任何值：

${json}

这只是提案。必须等待 Harness 原生审批，并且只有收到 CommitReceipt 后才能声明保存成功。`
}

function submissionBlocker(target: NovelWorkbenchTarget | undefined): string | undefined {
  if (target === undefined) return '当前没有可用会话，请先打开小说工作区中的会话。'
  if (target.agentPreset !== AI_NOVEL_PRESET_ID) {
    return '当前会话未使用“AI 小说作家”Preset，请新建或切换到该 Preset 会话。'
  }
  if (target.approval === 'never') {
    return '当前会话已关闭原生审批，请将权限切换为“工作区写入”后再提交。'
  }
  if (target.approval === 'unknown') {
    return '无法确认当前会话的审批策略，请切换到“工作区写入”后再提交。'
  }
  return undefined
}

function generationState(screen: NovelAssetEditorScreen): NovelAssetGenerationState {
  return screen.generation ?? { brief: '', phase: 'editing' }
}

function generationPending(screen: NovelAssetEditorScreen): boolean {
  const phase = generationState(screen).phase
  return phase === 'submitting' || phase === 'submitted'
}

function generationBlocksMutation(screen: NovelAssetEditorScreen): boolean {
  return generationPending(screen) || generationState(screen).phase === 'reconciling'
}

function generationAfterAssetEdit(screen: NovelAssetEditorScreen): NovelAssetGenerationState {
  const generation = generationState(screen)
  return generation.phase === 'applied'
    ? { brief: generation.brief, phase: 'editing' }
    : generation
}

function generationTargetLabel(target: NovelWorkbenchEditableTarget): string {
  switch (target.kind) {
    case 'project': return '项目设置'
    case 'characters': return '人物设定'
    case 'story-blueprint': return '故事蓝图'
    case 'chapter-blueprint': return `第 ${target.chapter} 章蓝图`
    case 'chapter-draft': return `第 ${target.chapter} 章正文`
  }
}

function generationSchema(target: NovelWorkbenchEditableTarget): string {
  switch (target.kind) {
    case 'project': return '完整严格 JSON：formatVersion、kind、projectId、title、language、genre、plannedChapters、targetWordsPerChapter、creativeStrategy、createdAt、updatedAt。保留 formatVersion、kind、projectId、createdAt；根据要求与上下文重新生成其余项目设置。本次生成至少修改一个用户可见的项目设置字段（title、language、genre、plannedChapters、targetWordsPerChapter、creativeStrategy）；只修改 updatedAt 是无效生成。updatedAt 必须更新为可往返解析的规范 UTC 时间，严格符合 YYYY-MM-DDTHH:mm:ss.sssZ。'
    case 'characters': return '完整严格 JSON：顶层只有 characters；每个人物只能包含 id、name、role、summary、goal、relationships、notes，relationships 项只能包含 characterId、type、summary。'
    case 'story-blueprint': return '完整严格 JSON：只包含 premise、themes、world、mainPlot、endingGoal；themes 是文本数组。'
    case 'chapter-blueprint': return `完整严格 JSON：只包含 chapter、title、purpose、beats、characterIds、continuityNotes、status；chapter 必须是 ${target.chapter}，三个列表字段都是文本数组。`
    case 'chapter-draft': return '完整 Markdown 正文，不要用 JSON 包裹；保持 UTF-8、LF 换行，并生成可直接保存的整章内容。'
  }
}

function canonicalInitializationIdentity(identity: NovelInitializationIdentity): NovelInitializationIdentity {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
  if (!uuid.test(identity.projectId)
    || identity.createdAt !== identity.updatedAt
    || !timestamp.test(identity.createdAt)
    || new Date(identity.createdAt).toISOString() !== identity.createdAt) {
    throw new Error('无法生成规范的项目 ID 或 UTC 时间戳。')
  }
  return identity
}

function generationMarkerLine(marker: string): string {
  return `[AI_NOVEL_UI_CORRELATION:${marker}]`
}

function resolvedGenerationBrief(brief: string): string {
  const trimmed = brief.trim()
  return trimmed === '' ? '没有额外补充要求；请根据当前资产和项目上下文自动完善。' : trimmed
}

function initializationGenerationPrompt(
  identity: NovelInitializationIdentity,
  brief: string,
  draft: NovelInitializationDraft,
): string {
  const fixed = JSON.stringify({
    kind: 'initialize',
    projectId: identity.projectId,
    createdAt: identity.createdAt,
    updatedAt: identity.updatedAt,
    title: '<根据用户要求生成>', language: '<BCP 47 语言标签>', genre: '<根据用户要求生成>',
    plannedChapters: '<正整数>', targetWordsPerChapter: '<正整数>',
    creativeStrategy: '<auto | fluent-drafting | consistency-first | deep-planning>',
  }, null, 2)
  return `请根据用户要求生成当前 Harness 小说项目的完整项目设置。\n\n用户要求：\n${resolvedGenerationBrief(brief)}\n\n当前工作台中的项目设置草稿仅作为用户意图参考，尚未写入磁盘：\n${JSON.stringify(draft, null, 2)}\n\n硬性执行顺序：\n1. 恰好调用一次 novel_read，读取 working-set，并确认结果为 NOT_INITIALIZED。若结果不同，停止且不得调用 novel_apply_change。\n2. 仅当第 1 步确认 NOT_INITIALIZED 时，恰好调用一次 novel_apply_change，kind 必须是 initialize，使用浅层参数，不要嵌套 request。\n3. projectId、createdAt、updatedAt 必须逐字使用下列固定值；createdAt 必须等于 updatedAt，时间格式严格为 YYYY-MM-DDTHH:mm:ss.sssZ。其余占位字段按要求生成：\n${fixed}\n4. novel_apply_change 会等待 Harness 原生审批结果。只有收到 CommitReceipt 后才能声明保存成功；收到 CommitReceipt 说明原生审批已经完成，最终回复不得再说“等待审批”。拒绝、取消或失败时不得重试写入。`
}

function generationContext(state: Extract<NovelWorkbenchState, { readonly status: 'ready' }>): string {
  return JSON.stringify({
    project: state.project,
    characters: state.characters,
    storyBlueprint: state.storyBlueprint,
    selectedChapter: state.progress.selectedChapter,
    chapterBlueprint: state.chapterBlueprint,
    draftPreview: state.draft?.preview ?? null,
  }, null, 2)
}

function assetDraftGuidance(screen: NovelAssetEditorScreen): unknown {
  switch (screen.kind) {
    case 'project': return screen.draft
    case 'characters': return screen.characters.map(character => ({
      id: character.id,
      name: character.name,
      role: character.role,
      summary: character.summary,
      goal: character.goal,
      relationships: character.relationshipsText,
      notes: character.notes,
    }))
    case 'story-blueprint': return {
      premise: screen.draft.premise,
      themes: screen.draft.themesText,
      world: screen.draft.world,
      mainPlot: screen.draft.mainPlot,
      endingGoal: screen.draft.endingGoal,
    }
    case 'chapter-blueprint': return {
      chapter: screen.chapter,
      title: screen.draft.title,
      purpose: screen.draft.purpose,
      beats: screen.draft.beatsText,
      characterIds: screen.draft.characterIdsText,
      continuityNotes: screen.draft.continuityNotesText,
      status: screen.draft.status,
    }
    case 'chapter-draft': return screen.text
    default: return assertNever(screen)
  }
}

function assetGenerationPrompt(
  state: Extract<NovelWorkbenchState, { readonly status: 'ready' }>,
  screen: NovelAssetEditorScreen,
  brief: string,
): string {
  const target = screen.kind === 'chapter-blueprint' || screen.kind === 'chapter-draft'
    ? { kind: screen.kind, chapter: screen.chapter }
    : { kind: screen.kind }
  const toolTarget = {
    targetKind: target.kind,
    ...('chapter' in target ? { chapter: target.chapter } : {}),
  }
  const read = JSON.stringify({ kind: 'asset', ...toolTarget }, null, 2)
  const apply = JSON.stringify({
    kind: 'replace',
    ...toolTarget,
    baseRevision: screen.baseRevision,
    replacement: '<按下述 schema 生成的完整资产文本>',
    summary: `AI 生成${generationTargetLabel(target)}`,
  }, null, 2)
  const draftGuidance = screen.dirty
    ? `\n当前工作台中的未提交草稿仅作为用户意图参考，尚未写入磁盘：\n${JSON.stringify(
        assetDraftGuidance(screen),
        null,
        2,
      )}\n`
    : ''
  return `请根据用户要求生成并提议更新“${generationTargetLabel(target)}”这一个小说资产。不要修改其他资产。

用户要求：
${resolvedGenerationBrief(brief)}
${draftGuidance}

当前工作台上下文仅供生成时保持一致：
${generationContext(state)}

硬性执行顺序：
1. 恰好调用一次 novel_read，并使用以下浅层参数：
${read}
2. 检查返回值未截断、未省略，并且 revision 与编辑器读取时的 revision：${screen.baseRevision} 完全一致。若不一致，停止并告知用户重新读取；不得调用 novel_apply_change。
3. 根据 novel_read 返回的完整 text 与上下文生成完整替换文本。格式要求：${generationSchema(target)}
4. 仅当第 2 步通过时，恰好调用一次 novel_apply_change。使用浅层参数，不要嵌套 request，不要把对象 stringify：
${apply}
5. 第 4 步示例已经显式包含编辑器读取到的 baseRevision；本次 novel_read 与第 2 步一致时必须保留它，不得省略。不要在工具参数中重抄 baseText；SHA-256 revision 是唯一的并发检查值，审批卡会展示完整 replacement。novel_apply_change 会等待 Harness 原生审批结果；只有收到 CommitReceipt 才能声明保存成功。收到 CommitReceipt 说明原生审批已经完成，最终回复不得再说“等待审批”。审批拒绝、取消或工具失败时不得重试写入。`
}

/**
 * Serialize one initialization proposal into the exact model-visible prompt.
 *
 * @param identity Stable project identity and timestamps generated for this proposal.
 * @param draft Validated user fields.
 * @returns Deterministic Chinese instructions containing one shallow JSON object.
 */
export function initializationProposalPrompt(
  identity: NovelInitializationIdentity,
  draft: NovelInitializationDraft,
): string {
  return initializationPromptFromJson(initializationProposalJson(identity, validateInitializationDraft(draft)))
}

/** Workbench controller with abort-on-supersede reads and prompt-to-quiescence disposal. */
export class NovelWorkbenchController {
  readonly #listeners = new Set<() => void>()
  readonly #port: NovelWorkbenchPort
  readonly #reportListenerError: (error: unknown) => void
  readonly #createIdentity: () => NovelInitializationIdentity
  readonly #now: () => string
  #state: NovelWorkbenchState = { status: 'idle', open: false }
  #target: NovelWorkbenchTarget | undefined
  #draft: NovelInitializationDraft = DEFAULT_INITIALIZATION
  #initializationGeneration: NovelInitializationGenerationState = { brief: '', phase: 'editing' }
  #generationCorrelationMarker: string | undefined
  #chapter = 1
  #request = 0
  #promptRequest = 0
  #activeRead: { readonly abort: AbortController; readonly done: Promise<void> } | undefined
  #activePrompt: Promise<void> | undefined
  #projectSource: ProjectManifestEditorSource | undefined
  #projectOriginal: NovelProjectSettingsDraft | undefined
  #charactersOriginal: readonly NovelCharacterDraft[] | undefined
  #chapterBlueprintOriginal: NovelChapterBlueprintDraft | undefined
  #chapterDraftOriginal: string | undefined
  #storyOriginal: NovelStoryBlueprintDraft | undefined
  #staleAsset: NovelAssetReadWireResult | undefined
  #latest: Promise<void> = Promise.resolve()
  #disposed = false

  /**
   * @param port Closed context-read and Session-prompt operations.
   * @param reportListenerError Error sink for isolated render subscriber failures.
   * @param createIdentity Identity factory invoked only after local form validation succeeds.
   * @param now Canonical timestamp factory used only when previewing a project-settings replacement.
   */
  public constructor(
    port: NovelWorkbenchPort,
    reportListenerError: (error: unknown) => void,
    createIdentity: () => NovelInitializationIdentity = defaultIdentity,
    now: () => string = () => new Date().toISOString(),
  ) {
    this.#port = port
    this.#reportListenerError = reportListenerError
    this.#createIdentity = createIdentity
    this.#now = now
  }

  /** @returns Current immutable workbench state. */
  public getSnapshot(): NovelWorkbenchState {
    return this.#state
  }

  /**
   * @param listener Callback invoked after each state transition.
   * @returns A disposer that removes the subscription.
   */
  public subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /**
   * @param target Current Workspace, Session, Preset, and known approval availability.
   * @returns Nothing; use {@link whenIdle} to await a triggered read.
   */
  public setTarget(target: NovelWorkbenchTarget | undefined): void {
    if (this.#disposed) return
    if (target?.workspaceId === this.#target?.workspaceId
      && target?.sessionId === this.#target?.sessionId
      && target?.agentPreset === this.#target?.agentPreset
      && target?.approval === this.#target?.approval) return
    this.#promptRequest += 1
    this.#target = target
    this.#chapter = 1
    if (target === undefined) {
      this.#cancelRead()
      this.#set({ status: 'empty', open: this.#state.open })
    } else {
      void this.#startRead('inspect')
    }
  }

  /** @returns Completion after the initial context read settles. */
  public open(): Promise<void> {
    if (this.#disposed) return Promise.resolve()
    this.#set({ ...this.#state, open: true })
    return this.#startRead('open')
  }

  /**
   * Read project evidence without opening the drawer, for Plugin Configuration and diagnostics.
   *
   * @returns Completion after the Host read settles.
   */
  public inspect(): Promise<void> {
    return this.#startRead('inspect')
  }

  /** @returns Nothing. */
  public close(): void {
    if (this.#disposed) return
    this.#set({ ...this.#state, open: false })
  }

  /**
   * Replace initialization draft fields and clear a prior submission result.
   *
   * @param patch Fields changed by the user.
   * @returns Nothing; edits are ignored while prompt admission is pending or the proposal awaits approval.
   * @throws When the project is not in the initialization state.
   */
  public updateInitialization(patch: Partial<NovelInitializationDraft>): void {
    if (this.#state.status !== 'not-initialized') throw new Error('Novel project is not awaiting initialization')
    if (this.#activePrompt !== undefined
      || this.#state.initialization.phase === 'submitted'
      || this.#initializationGeneration.phase === 'submitted'
      || this.#initializationGeneration.phase === 'reconciling') return
    this.#draft = { ...this.#draft, ...patch }
    this.#set({
      status: 'not-initialized',
      open: this.#state.open,
      initialization: {
        draft: this.#draft,
        phase: 'editing',
        generation: this.#initializationGeneration,
        ...(submissionBlocker(this.#target) === undefined ? {} : { blocker: submissionBlocker(this.#target) }),
      },
      ...(this.#state.readFeedback === undefined ? {} : { readFeedback: this.#state.readFeedback }),
    })
  }

  /** Update the optional model brief for generating the first project settings proposal. @param brief User intent, or empty text to use the current form and defaults. @returns Nothing. */
  public updateInitializationGenerationBrief(brief: string): void {
    if (this.#state.status !== 'not-initialized') return
    if (this.#activePrompt !== undefined
      || this.#initializationGeneration.phase === 'submitted'
      || this.#initializationGeneration.phase === 'reconciling') return
    this.#initializationGeneration = { brief, phase: 'editing' }
    this.#publishInitializationGeneration()
  }

  /** Ask the selected Session to generate exactly one approval-gated initialization using the current form as guidance. @returns Session admission completion. */
  public async generateInitialization(): Promise<void> {
    if (this.#disposed || this.#state.status !== 'not-initialized' || this.#activePrompt !== undefined
      || this.#initializationGeneration.phase === 'submitted'
      || this.#initializationGeneration.phase === 'reconciling') return
    const blocker = submissionBlocker(this.#target)
    const message = blocker
    if (message !== undefined || this.#target === undefined) {
      this.#initializationGeneration = { ...this.#initializationGeneration, phase: 'error', message }
      this.#publishInitializationGeneration()
      return
    }
    let identity: NovelInitializationIdentity
    try {
      identity = canonicalInitializationIdentity(this.#createIdentity())
    } catch (error) {
      this.#initializationGeneration = {
        ...this.#initializationGeneration, phase: 'error',
        message: error instanceof Error ? error.message : String(error),
      }
      this.#publishInitializationGeneration()
      return
    }
    const marker = crypto.randomUUID()
    this.#generationCorrelationMarker = marker
    const prompt = `${generationMarkerLine(marker)}\n此标记只供小说工作台对账；不得把它写入任何小说资产或工具参数。\n\n${initializationGenerationPrompt(identity, this.#initializationGeneration.brief, this.#draft)}`
    this.#initializationGeneration = { ...this.#initializationGeneration, identity, phase: 'submitting', message: undefined }
    this.#publishInitializationGeneration()
    const request = ++this.#promptRequest
    const done = this.#submitInitializationGeneration(request, this.#target.sessionId, prompt)
    this.#activePrompt = done
    await done
    if (this.#activePrompt === done) this.#activePrompt = undefined
    if (this.#initializationGeneration.phase === 'reconciling') await this.refresh()
  }

  /**
   * Validate the current draft and expose the exact values that a later Session prompt will carry.
   *
   * @returns Nothing; validation failures are published in initialization state and pending submissions are unchanged.
   */
  public previewInitialization(): void {
    if (this.#disposed || this.#state.status !== 'not-initialized') return
    if (this.#activePrompt !== undefined
      || this.#state.initialization.phase === 'submitted'
      || this.#initializationGeneration.phase === 'submitted'
      || this.#initializationGeneration.phase === 'reconciling') return
    const blocker = submissionBlocker(this.#target)
    if (blocker !== undefined) {
      this.#setInitializationError(blocker)
      return
    }
    try {
      const fields = validateInitializationDraft(this.#draft)
      const json = initializationProposalJson(this.#createIdentity(), fields)
      const prompt = initializationPromptFromJson(json)
      this.#setInitializationPhase('preview', { json, prompt })
    } catch (error) {
      this.#setInitializationError(error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * Read one recognized editable asset and drill into its compact editor.
   *
   * @param target One recognized editable asset; chapter assets include their fixed chapter number.
   * @returns Completion after the exact revision read settles.
   */
  public openAsset(target: NovelWorkbenchEditableTarget): Promise<void> {
    if (this.#disposed || this.#state.status !== 'ready') return Promise.resolve()
    this.#promptRequest += 1
    this.#staleAsset = undefined
    return this.#startAssetRead(target, 'open')
  }

  /** Return a clean editor to the asset list; unsaved or pending state stays visible until explicitly resolved. @returns Nothing. */
  public backToAssets(): void {
    if (this.#disposed || this.#state.status !== 'ready') return
    const screen = this.#assetScreen()
    if (screen !== undefined && (screen.dirty
      || screen.phase === 'submitting'
      || screen.phase === 'submitted'
      || screen.phase === 'stale'
      || generationBlocksMutation(screen))) return
    this.#promptRequest += 1
    this.#cancelRead()
    this.#staleAsset = undefined
    this.#setReadyScreen({ kind: 'root' })
  }

  /**
   * Update project settings while immutable manifest fields remain controller-owned.
   *
   * @param patch Editable fields changed by the user.
   * @returns Nothing; changes are ignored while prompt admission is pending or approval is awaited.
   */
  public updateProjectSettings(patch: Partial<NovelProjectSettingsDraft>): void {
    const screen = this.#projectScreen()
    if (screen === undefined || !this.#assetMayChange(screen)) return
    const draft = { ...screen.draft, ...patch }
    const dirty = this.#projectOriginal !== undefined && JSON.stringify(draft) !== JSON.stringify(this.#projectOriginal)
    this.#setReadyScreen({
      ...screen,
      draft,
      dirty,
      phase: dirty ? 'editing' : 'clean',
      replacement: undefined,
      preview: undefined,
      message: undefined,
      generation: generationAfterAssetEdit(screen),
    })
  }

  /**
   * Update the complete story-blueprint draft.
   *
   * @param patch Story fields changed by the user.
   * @returns Nothing; edits are ignored while prompt admission or approval is pending.
   */
  public updateStoryBlueprint(patch: Partial<NovelStoryBlueprintDraft>): void {
    const screen = this.#storyScreen()
    if (screen === undefined || !this.#assetMayChange(screen)) return
    const draft = { ...screen.draft, ...patch }
    const dirty = this.#storyOriginal !== undefined && JSON.stringify(draft) !== JSON.stringify(this.#storyOriginal)
    this.#setReadyScreen({
      ...screen,
      draft,
      dirty,
      phase: dirty ? 'editing' : 'clean',
      replacement: undefined,
      preview: undefined,
      message: undefined,
      generation: generationAfterAssetEdit(screen),
    })
  }

  /**
   * Update the selected chapter-blueprint draft.
   *
   * @param patch Planning fields changed by the user.
   * @returns Nothing; edits are ignored while prompt admission or approval is pending.
   */
  public updateChapterBlueprint(patch: Partial<NovelChapterBlueprintDraft>): void {
    const screen = this.#chapterBlueprintScreen()
    if (screen === undefined || !this.#assetMayChange(screen)) return
    const draft = { ...screen.draft, ...patch }
    const dirty = this.#chapterBlueprintOriginal !== undefined
      && JSON.stringify(draft) !== JSON.stringify(this.#chapterBlueprintOriginal)
    this.#setReadyScreen({
      ...screen,
      draft,
      dirty,
      phase: dirty ? 'editing' : 'clean',
      replacement: undefined,
      preview: undefined,
      message: undefined,
      generation: generationAfterAssetEdit(screen),
    })
  }

  /**
   * Replace the selected chapter's complete Markdown draft.
   *
   * @param text Complete edited Markdown.
   * @returns Nothing; edits are ignored while prompt admission or approval is pending.
   */
  public updateChapterDraft(text: string): void {
    const screen = this.#chapterDraftScreen()
    if (screen === undefined || !this.#assetMayChange(screen)) return
    const dirty = this.#chapterDraftOriginal !== undefined && text !== this.#chapterDraftOriginal
    this.#setReadyScreen({
      ...screen,
      text,
      dirty,
      phase: dirty ? 'editing' : 'clean',
      replacement: undefined,
      preview: undefined,
      message: undefined,
      generation: generationAfterAssetEdit(screen),
    })
  }

  /**
   * Replace the human-readable summary attached to the eventual single-asset proposal.
   *
   * @param summary Short explanation shown in the model request and approval card.
   * @returns Nothing; changes are ignored while prompt admission is pending or approval is awaited.
   */
  public updateAssetSummary(summary: string): void {
    const screen = this.#assetScreen()
    if (screen === undefined || !this.#assetMayChange(screen)) return
    this.#setReadyScreen({ ...screen, summary, phase: screen.dirty ? 'editing' : 'clean', preview: undefined, message: undefined })
  }

  /** Update the selected model's optional generation brief without changing any asset draft. @param brief User intent, or empty text to rely on current context. @returns Nothing. */
  public updateAssetGenerationBrief(brief: string): void {
    const screen = this.#assetScreen()
    if (screen === undefined || generationBlocksMutation(screen)) return
    this.#setReadyScreen({
      ...screen,
      generation: { brief, phase: 'editing' },
    })
  }

  /** Ask the selected Session model for one read-then-approval-gated asset proposal, including a dirty form as unsaved guidance. @returns Session admission completion. */
  public async generateAsset(): Promise<void> {
    const screen = this.#assetScreen()
    if (this.#disposed || screen === undefined || this.#activePrompt !== undefined || generationBlocksMutation(screen)) return
    const currentGeneration = generationState(screen)
    const blocker = submissionBlocker(this.#target)
    const manualProposalPending = screen.phase !== 'clean' && screen.phase !== 'editing'
    const message = blocker
      ?? (manualProposalPending
        ? '当前手动修改已进入提案流程。请在底部提交手动修改到当前会话，或放弃修改后再生成。'
        : undefined)
    if (message !== undefined || this.#target === undefined || this.#state.status !== 'ready') {
      this.#setReadyScreen({
        ...screen,
        generation: { ...currentGeneration, phase: 'error', message: message ?? '当前会话不可用。' },
      })
      return
    }
    const marker = crypto.randomUUID()
    this.#generationCorrelationMarker = marker
    const prompt = `${generationMarkerLine(marker)}\n此标记只供小说工作台对账；不得把它写入任何小说资产或工具参数。\n\n${assetGenerationPrompt(this.#state, screen, currentGeneration.brief)}`
    this.#cancelRead()
    this.#setReadyScreen({
      ...screen,
      generation: { brief: currentGeneration.brief, phase: 'submitting' },
    })
    const request = ++this.#promptRequest
    const done = this.#submitGeneration(request, this.#target.sessionId, prompt)
    this.#activePrompt = done
    await done
    if (this.#activePrompt === done) this.#activePrompt = undefined
    if (this.#assetScreen() !== undefined && generationState(this.#assetScreen()!).phase === 'reconciling') {
      await this.refresh()
    }
  }

  /**
   * Filter the in-memory characters list without changing durable content.
   *
   * @param search Case-insensitive id, name, role, summary, or goal query.
   * @returns Nothing.
   */
  public setCharacterSearch(search: string): void {
    const screen = this.#charactersScreen()
    if (screen === undefined) return
    this.#setReadyScreen({ ...screen, search, visibleCharacterIds: visibleCharacterIds(screen.characters, search) })
  }

  /**
   * Select one existing character record.
   *
   * @param id Stable character id in the current complete asset.
   * @returns Nothing.
   * @throws {Error} When the id is not present.
   */
  public selectCharacter(id: string): void {
    const screen = this.#charactersScreen()
    if (screen === undefined) return
    if (!screen.characters.some(character => character.id === id)) throw new Error('Character does not exist')
    this.#setReadyScreen({ ...screen, selectedId: id })
  }

  /**
   * Add and select one empty character draft.
   *
   * @returns Nothing; the stable internal id is generated automatically and submitted editors are unchanged.
   */
  public createCharacter(): void {
    const screen = this.#charactersScreen()
    if (screen === undefined || !this.#assetMayChange(screen)) return
    const generatedId = crypto.randomUUID()
    if (screen.characters.some(character => character.id === generatedId)) {
      this.#setReadyScreen({ ...screen, phase: 'error', message: '无法生成唯一的人物标识，请重试。' })
      return
    }
    const characters = [...screen.characters, {
      id: generatedId,
      name: '',
      role: '',
      summary: '',
      goal: '',
      relationshipsText: '',
      notes: '',
    }]
    this.#setCharactersDraft(screen, characters, generatedId)
  }

  /**
   * Update the selected character record.
   *
   * @param patch Editable character fields.
   * @returns Nothing; changes are ignored without a selection or during prompt admission.
   */
  public updateCharacter(patch: Partial<Omit<NovelCharacterDraft, 'id'>>): void {
    const screen = this.#charactersScreen()
    if (screen === undefined || screen.selectedId === undefined || !this.#assetMayChange(screen)) return
    const selectedIndex = screen.characters.findIndex(character => character.id === screen.selectedId)
    const characters = screen.characters.map(character => character.id === screen.selectedId
      ? { ...character, ...patch }
      : character)
    this.#setCharactersDraft(screen, characters, characters[selectedIndex]?.id)
  }

  /** Remove the selected character from the proposed complete asset. @returns Nothing. */
  public deleteCharacter(): void {
    const screen = this.#charactersScreen()
    if (screen === undefined || screen.selectedId === undefined || !this.#assetMayChange(screen)) return
    const index = screen.characters.findIndex(character => character.id === screen.selectedId)
    const characters = screen.characters.filter(character => character.id !== screen.selectedId)
    const selectedId = characters[Math.min(index, characters.length - 1)]?.id
    this.#setCharactersDraft(screen, characters, selectedId)
  }

  /** Validate and expose the exact single-asset replacement prompt. @returns Nothing; errors remain visible in editor state. */
  public previewAssetChange(): void {
    const screen = this.#assetScreen()
    if (screen === undefined || this.#activePrompt !== undefined || screen.phase === 'submitted' || screen.phase === 'stale') return
    const blocker = submissionBlocker(this.#target)
    if (blocker !== undefined || !screen.dirty) {
      this.#setReadyScreen({ ...screen, phase: 'error', message: blocker ?? '没有需要提交的修改。' })
      return
    }
    try {
      const replacement = screen.kind === 'project'
        ? serializeProject(this.#requiredProjectSource(), screen.draft, this.#now())
        : screen.kind === 'characters'
          ? serializeCharacters(screen.characters)
          : screen.kind === 'story-blueprint'
            ? serializeStoryBlueprint(screen.draft)
            : screen.kind === 'chapter-blueprint'
              ? serializeChapterBlueprint(screen.chapter, screen.draft)
              : serializeChapterDraft(screen.text)
      const target = this.#screenTarget(screen)
      const prompt = assetProposalPrompt(target, screen.baseRevision, replacement, screen.summary)
      this.#setReadyScreen({ ...screen, phase: 'preview', replacement, preview: { prompt, replacement }, message: undefined })
    } catch (error) {
      this.#setReadyScreen({ ...screen, phase: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Submit the exact preview through the selected Session without writing from the browser.
   *
   * @returns Completion after Session admission; duplicate and stale submissions return immediately.
   */
  public async submitAssetChange(): Promise<void> {
    const screen = this.#assetScreen()
    if (this.#disposed
      || screen === undefined
      || this.#activePrompt !== undefined
      || screen.preview === undefined
      || (screen.phase !== 'preview' && screen.phase !== 'error')) return
    const target = this.#target
    const blocker = submissionBlocker(target)
    if (target === undefined || blocker !== undefined) {
      this.#setReadyScreen({ ...screen, phase: 'error', message: blocker ?? '请先预览修改。' })
      return
    }
    this.#cancelRead()
    this.#setReadyScreen({ ...screen, phase: 'submitting', message: undefined })
    const request = ++this.#promptRequest
    const done = this.#submitAsset(request, target.sessionId, screen.preview.prompt)
    this.#activePrompt = done
    await done
    if (this.#activePrompt === done) this.#activePrompt = undefined
  }

  /**
   * Publish one completed `novel_apply_change` outcome before its authoritative asset reread.
   *
   * @param outcome Durable tool error identity; successful values remain filesystem-authoritative.
   * @returns Nothing; rejected edits stay dirty and no result is interpreted as a browser write.
   */
  public novelApplySettled(outcome: NovelApplyOutcome): void {
    if (this.#disposed) return
    const editor = this.#assetScreen()
    const editorGeneration = editor === undefined ? undefined : generationState(editor)
    if (editor !== undefined
      && editorGeneration?.phase === 'submitted'
      && outcome.attribution?.kind === 'replace'
      && outcome.attribution.targetKind === editor.kind
      && outcome.attribution.chapter === ('chapter' in editor ? editor.chapter : undefined)
      && outcome.attribution.baseRevision === editor.baseRevision) {
      if (!outcome.isError) {
        this.#setReadyScreen({
          ...editor,
          generation: {
            ...editorGeneration,
            ...(outcome.newRevision === undefined ? {} : { expectedRevision: outcome.newRevision }),
            expectedReplacement: outcome.attribution.replacement,
            message: '模型生成已通过工具执行，正在重新读取已批准的资产。',
          },
        })
        return
      }
      this.#setReadyScreen({
        ...editor,
        generation: {
          ...editorGeneration,
          phase: 'error',
          message: outcome.code === 'APPROVAL_REJECTED'
            ? 'Harness 原生审批已拒绝；磁盘未改变。'
            : outcome.code === 'STALE_REVISION'
              ? '生成提案使用的 revision 已过期；请重新读取后再生成。'
              : outcome.code === undefined
                ? '生成提案未保存；请查看对话中的工具结果。'
                : `生成提案未保存：${outcome.code}`,
        },
      })
      return
    }
    if (editor !== undefined
      && editor.phase === 'submitted'
      && outcome.isError
      && outcome.attribution?.kind === 'replace'
      && outcome.attribution.targetKind === editor.kind
      && outcome.attribution.chapter === ('chapter' in editor ? editor.chapter : undefined)
      && outcome.attribution.baseRevision === editor.baseRevision
      && outcome.attribution.replacement === editor.replacement) {
      if (outcome.code === 'STALE_REVISION') {
        this.#setReadyScreen({
          ...editor,
          phase: 'stale',
          message: '提交使用的 revision 已过期。当前提案仍保留；重新读取最新版本后再核对修改。',
        })
        return
      }
      const rejected = outcome.code === 'APPROVAL_REJECTED'
      this.#setReadyScreen({
        ...editor,
        phase: 'error',
        message: rejected
          ? 'Harness 原生审批已拒绝；磁盘未改变，当前修改仍保留。'
          : outcome.code === undefined
            ? '修改未保存；原生审批可能被拒绝或工具执行失败。当前修改仍保留，请查看对话详情。'
            : `修改未保存：${outcome.code}`,
      })
      return
    }
    if (this.#state.status === 'not-initialized'
      && this.#state.initialization.phase === 'submitted'
      && outcome.isError
      && outcome.attribution?.kind === 'initialize'
      && outcome.attribution.requestJson === this.#state.initialization.preview?.json) {
      this.#setInitializationError(outcome.code === 'APPROVAL_REJECTED'
        ? 'Harness 原生审批已拒绝；小说项目仍未初始化。'
        : outcome.code === undefined
          ? '初始化未保存；原生审批可能被拒绝或工具执行失败。请查看对话详情。'
          : `初始化未保存：${outcome.code}`)
      return
    }
    if (this.#state.status === 'not-initialized'
      && this.#initializationGeneration.phase === 'submitted'
      && outcome.attribution?.kind === 'initialize') {
      const identity = this.#initializationGeneration.identity
      let attributed: Record<string, unknown> | undefined
      try {
        attributed = JSON.parse(outcome.attribution.requestJson) as Record<string, unknown>
      } catch {
        attributed = undefined
      }
      if (identity !== undefined
        && attributed?.projectId === identity.projectId
        && attributed.createdAt === identity.createdAt
        && attributed.updatedAt === identity.updatedAt) {
        this.#initializationGeneration = outcome.isError
          ? {
              ...this.#initializationGeneration,
              phase: 'error',
              message: outcome.code === 'APPROVAL_REJECTED'
                ? 'Harness 原生审批已拒绝；小说项目仍未初始化。'
                : `项目设置生成未保存${outcome.code === undefined ? '。' : `：${outcome.code}`}`,
            }
          : {
              ...this.#initializationGeneration,
              ...(outcome.newRevision === undefined ? {} : { expectedRevision: outcome.newRevision }),
              message: '模型生成已通过工具执行，正在重新读取项目。',
            }
        this.#publishInitializationGeneration()
      }
    }
  }

  /** Mark the admitted generation turn complete and require an authoritative reread before another generation. @returns Nothing. */
  public generationTurnSettled(): void {
    if (this.#disposed) return
    const editor = this.#assetScreen()
    if (editor !== undefined
      && (generationState(editor).phase === 'submitting' || generationState(editor).phase === 'submitted')) {
      this.#setReadyScreen({
        ...editor,
        generation: {
          ...generationState(editor), phase: 'reconciling',
          message: '模型轮次已结束，正在通过权威资产读取确认结果。',
        },
      })
      return
    }
    if (this.#state.status === 'not-initialized'
      && (this.#initializationGeneration.phase === 'submitting'
        || this.#initializationGeneration.phase === 'submitted')) {
      this.#initializationGeneration = {
        ...this.#initializationGeneration, phase: 'reconciling',
        message: '模型轮次已结束，正在通过权威项目读取确认结果。',
      }
      this.#publishInitializationGeneration()
    }
  }

  /** @returns Correlation marker for the unresolved model-generation prompt, if any. */
  public currentGenerationCorrelationMarker(): string | undefined {
    const editor = this.#assetScreen()
    const editorPhase = editor === undefined ? undefined : generationState(editor).phase
    const active = editorPhase === 'submitting' || editorPhase === 'submitted' || editorPhase === 'reconciling'
      || this.#initializationGeneration.phase === 'submitting'
      || this.#initializationGeneration.phase === 'submitted'
      || this.#initializationGeneration.phase === 'reconciling'
    return active ? this.#generationCorrelationMarker : undefined
  }

  /** Fail an unresolved generation whose admitted queue row vanished before durable execution. @returns Nothing. */
  public generationPromptLost(): void {
    if (this.#disposed) return
    const editor = this.#assetScreen()
    if (editor !== undefined && generationBlocksMutation(editor)) {
      this.#promptRequest += 1
      this.#generationCorrelationMarker = undefined
      this.#setReadyScreen({
        ...editor,
        generation: {
          ...generationState(editor), phase: 'error',
          message: '生成请求已从会话队列移除，且未形成可对账的用户消息；未执行小说修改，可以重试。',
        },
      })
      return
    }
    if (this.#state.status === 'not-initialized'
      && (this.#initializationGeneration.phase === 'submitting'
        || this.#initializationGeneration.phase === 'submitted'
        || this.#initializationGeneration.phase === 'reconciling')) {
      this.#promptRequest += 1
      this.#generationCorrelationMarker = undefined
      this.#initializationGeneration = {
        ...this.#initializationGeneration, phase: 'error',
        message: '生成请求已从会话队列移除，且未形成可对账的用户消息；项目仍未初始化，可以重试。',
      }
      this.#publishInitializationGeneration()
    }
  }

  /** Replace a stale dirty editor with the latest authoritative asset. @returns Nothing. */
  public reloadStaleAsset(): void {
    const latest = this.#staleAsset
    const editor = this.#assetScreen()
    if (latest === undefined) {
      if (editor !== undefined && editor.phase === 'stale') {
        void this.#startAssetRead(this.#screenTarget(editor), 'reload')
      }
      return
    }
    if (this.#state.status !== 'ready') return
    this.#staleAsset = undefined
    this.#loadAsset(latest)
  }

  /** Restore the exact base asset and discard unsent local edits. @returns Nothing. */
  public discardAssetChanges(): void {
    const screen = this.#assetScreen()
    if (screen === undefined || this.#activePrompt !== undefined) return
    const target = this.#screenTarget(screen)
    this.#loadAsset({
      target,
      revision: screen.baseRevision,
      text: screen.originalText,
      bytes: new TextEncoder().encode(screen.originalText).byteLength,
    })
  }

  /**
   * Select and read one planned chapter while the workbench is open.
   *
   * @param chapter One-based chapter number within the loaded project plan.
   * @returns Completion after the read settles; invalid selections publish recoverable feedback without reading.
   */
  public selectChapter(chapter: number): Promise<void> {
    const planned = this.#state.status === 'ready' ? this.#state.project.plannedChapters : undefined
    if (!Number.isSafeInteger(chapter) || chapter <= 0 || (planned !== undefined && chapter > planned)) {
      if (this.#state.status === 'ready') {
        this.#set({
          ...this.#state,
          readFeedback: {
            kind: 'error',
            message: `章节编号必须在 1 到 ${this.#state.project.plannedChapters} 之间。`,
          },
        })
      }
      return Promise.resolve()
    }
    this.#chapter = chapter
    return this.#state.open ? this.#startRead('refresh') : Promise.resolve()
  }

  /**
   * Validate and submit the current initialization proposal through the selected Session.
   *
   * @returns Completion after the Session accepts or rejects the queued prompt; duplicates return immediately.
   */
  public async submitInitialization(): Promise<void> {
    if (this.#disposed || this.#state.status !== 'not-initialized') return
    if (this.#activePrompt !== undefined
      || this.#state.initialization.phase === 'submitting'
      || this.#state.initialization.phase === 'submitted'
      || this.#initializationGeneration.phase === 'submitted'
      || this.#initializationGeneration.phase === 'reconciling') return
    const target = this.#target
    const blocker = submissionBlocker(target)
    if (blocker !== undefined || target === undefined) {
      this.#setInitializationError(blocker ?? '当前没有可用会话，请先打开小说工作区中的会话。')
      return
    }
    const preview = this.#state.initialization.preview
    if (preview === undefined) {
      this.#setInitializationError('请先预览并确认初始化提案的完整值。')
      return
    }
    this.#setInitializationPhase('submitting', preview)
    const request = ++this.#promptRequest
    const done = this.#submit(request, target.sessionId, preview.prompt)
    this.#activePrompt = done
    await done
    if (this.#activePrompt === done) this.#activePrompt = undefined
    this.#resetStalePromptState(request)
  }

  /** @returns Completion after an explicit reread settles, or immediately while closed. */
  public refresh(): Promise<void> {
    if (this.#activePrompt !== undefined) return Promise.resolve()
    const screen = this.#assetScreen()
    if (screen !== undefined) return this.#startAssetRead(this.#screenTarget(screen), 'refresh')
    if (!this.#state.open) return Promise.resolve()
    return this.#startRead('refresh')
  }

  /** Abort the active read and expose disconnected state without waiting for settlement. @returns Nothing. */
  public disconnected(): void {
    if (this.#disposed) return
    this.#cancelRead()
    if (this.#activePrompt !== undefined) {
      const pendingEditor = this.#assetScreen()
      if (pendingEditor !== undefined) {
        const generation = generationState(pendingEditor)
        this.#setReadyScreen(generation.phase === 'submitting'
          ? {
              ...pendingEditor,
              generation: {
                ...generation,
                message: 'Harness 连接已断开；生成请求是否已进入会话尚未确定，结果返回前不能重试。',
              },
            }
          : {
              ...pendingEditor,
              phase: 'submitting',
              message: 'Harness 连接已断开；提案是否已进入会话尚未确定，结果返回前不能重试。',
            }, { kind: 'disconnected', message: 'Harness 连接已断开，正在等待原提案结果。' })
      } else if (this.#state.status === 'not-initialized') {
        this.#set({
          ...this.#state,
          initialization: {
            ...this.#state.initialization,
            phase: 'submitting',
            message: 'Harness 连接已断开；初始化提案是否已进入会话尚未确定，结果返回前不能重试。',
          },
          readFeedback: { kind: 'disconnected', message: 'Harness 连接已断开，正在等待原提案结果。' },
        })
      }
      return
    }
    this.#promptRequest += 1
    const editor = this.#assetScreen()
    if (editor !== undefined) {
      this.#setReadyScreen({
        ...editor,
        phase: 'error',
        message: 'Harness 连接已断开；当前未发送修改仍保留在浏览器中。',
      }, { kind: 'disconnected', message: '读取失败：Harness 连接已断开。' })
      return
    }
    this.#set({
      status: 'disconnected',
      open: this.#state.open,
      readFeedback: { kind: 'disconnected', message: '读取失败：Harness 连接已断开。' },
    })
  }

  /** @returns Completion after the latest triggered read and prompt settle. */
  public async whenIdle(): Promise<void> {
    let latest: Promise<void>
    do {
      latest = this.#latest
      await latest
    } while (latest !== this.#latest)
    await this.#activePrompt
  }

  /** Abort reads, await the non-cancellable Session prompt, and stop publishing state. @returns Quiescent completion. */
  public async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#listeners.clear()
    this.#cancelRead()
    await Promise.all([this.whenIdle(), this.#activePrompt])
  }

  #startRead(reason: 'open' | 'inspect' | 'refresh' = 'open'): Promise<void> {
    const latest = this.#runRead(reason)
    this.#latest = latest
    return latest
  }

  #startAssetRead(target: NovelWorkbenchEditableTarget, reason: 'open' | 'refresh' | 'reload'): Promise<void> {
    const latest = this.#runAssetRead(target, reason)
    this.#latest = latest
    return latest
  }

  async #runAssetRead(target: NovelWorkbenchEditableTarget, reason: 'open' | 'refresh' | 'reload'): Promise<void> {
    if (this.#disposed || this.#state.status !== 'ready') return
    const selected = this.#target
    if (selected === undefined) return
    const request = ++this.#request
    const previous = this.#activeRead
    previous?.abort.abort()
    if (reason === 'open') this.#setReadyScreen({ kind: 'asset-loading', target })
    else this.#set({
      ...this.#state,
      readFeedback: { kind: 'loading', message: '正在重新读取当前资产…' },
    })
    await previous?.done
    if (this.#disposed || request !== this.#request) return
    const abort = new AbortController()
    const done = this.#settleAssetRead(request, selected, target, reason, abort.signal)
    const active = { abort, done }
    this.#activeRead = active
    await done
    if (this.#activeRead === active) this.#activeRead = undefined
  }

  async #settleAssetRead(
    request: number,
    selected: NovelWorkbenchTarget,
    target: NovelWorkbenchEditableTarget,
    reason: 'open' | 'refresh' | 'reload',
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const result = await this.#port.readAsset(selected.workspaceId, target, signal)
      if (this.#disposed || request !== this.#request || this.#state.status !== 'ready') return
      if (!sameAssetTarget(result.target, target)) throw new Error('Host returned a different novel asset')
      if (reason === 'reload') {
        this.#staleAsset = undefined
        this.#loadAsset(result, { kind: 'success', message: '重新载入完成：已载入最新资产 revision。' })
        return
      }
      const current = this.#assetScreen()
      if (reason === 'refresh' && current?.phase === 'submitted' && result.revision === current.baseRevision) {
        this.#setReadyScreen({ ...current, message: '提案已发送，正在等待原生审批或资产 revision 更新。' }, {
          kind: 'success', message: '重新读取完成：资产尚未发生已批准的修改。',
        })
        return
      }
      if (reason === 'refresh' && current !== undefined
        && (generationState(current).phase === 'submitted' || generationState(current).phase === 'reconciling')) {
        const pending = generationState(current)
        if ((pending.expectedRevision !== undefined && result.revision === pending.expectedRevision)
          || (pending.expectedRevision === undefined
            && pending.expectedReplacement !== undefined
            && result.text === pending.expectedReplacement)) {
          this.#staleAsset = undefined
          const message = `模型生成已批准并载入 revision ${result.revision.slice(0, 12)}；上方字段是磁盘中的最终内容。`
          this.#loadAsset(result, {
            kind: 'success',
            message,
          })
          const loaded = this.#assetScreen()
          if (loaded !== undefined && sameAssetTarget(loaded, result.target)) {
            this.#setReadyScreen({
              ...loaded,
              generation: {
                brief: pending.brief,
                phase: 'applied',
                message,
                expectedRevision: result.revision,
                expectedReplacement: result.text,
              },
            })
          }
        } else if (pending.expectedReplacement === undefined && result.revision === current.baseRevision) {
          this.#setReadyScreen({
            ...current,
            generation: pending.phase === 'reconciling'
              ? { ...pending, phase: 'error', message: '模型轮次未产生可归因的修改；磁盘仍保持生成前的 revision。可以修改要求后重试。' }
              : { ...pending, message: '生成请求已发送，正在等待模型提案、原生审批或资产 revision 更新。' },
          }, { kind: 'success', message: '重新读取完成：资产尚未发生已批准的生成修改。' })
        } else {
          this.#staleAsset = result
          this.#setReadyScreen({
            ...current,
            phase: 'stale',
            latestRevision: result.revision,
            message: pending.expectedReplacement === undefined
              ? '模型生成等待审批期间资产发生了其他修改。请重新载入后再生成。'
              : '批准后的资产内容与模型提交的完整替换文本不一致。请重新载入并核对。',
            generation: {
              ...pending,
              phase: 'error',
              message: '未把当前磁盘内容识别为本次模型生成结果。',
            },
          }, { kind: 'success', message: '重新读取完成：发现了不属于本次生成提案的资产 revision。' })
        }
        return
      }
      if (reason === 'refresh'
        && current !== undefined
        && generationState(current).phase === 'error'
        && result.revision === current.baseRevision) {
        this.#setReadyScreen(current, { kind: 'success', message: '重新读取完成：磁盘仍保持生成前的 revision。' })
        return
      }
      if (reason === 'refresh' && current?.phase === 'submitted' && result.revision !== current.baseRevision) {
        if (current.replacement === result.text) {
          this.#staleAsset = undefined
          this.#loadAsset(result, { kind: 'success', message: '重新读取完成：已载入批准后的资产 revision。' })
        } else {
          this.#staleAsset = result
          this.#setReadyScreen({
            ...current,
            phase: 'stale',
            latestRevision: result.revision,
            message: '资产已被其他修改更新，内容与已提交提案不一致。提案仍保留，请核对后重新载入。',
          }, { kind: 'success', message: '重新读取完成：发现了不同于已提交提案的资产 revision。' })
        }
        return
      }
      if (reason === 'refresh' && current !== undefined && current.dirty && result.revision !== current.baseRevision) {
        this.#staleAsset = result
        this.#setReadyScreen({
          ...current,
          phase: 'stale',
          latestRevision: result.revision,
          message: '磁盘内容已变化。当前未发送修改已保留；重新载入后才能继续提交。',
        }, { kind: 'success', message: '重新读取完成：发现了更新的资产 revision。' })
        return
      }
      if (reason === 'refresh' && current !== undefined && current.dirty) {
        this.#setReadyScreen(current, { kind: 'success', message: '重新读取完成：当前 revision 未变化。' })
        return
      }
      this.#staleAsset = undefined
      this.#loadAsset(result, { kind: 'success', message: '读取完成：已载入精确资产 revision。' })
    } catch (error) {
      if (this.#disposed || request !== this.#request || this.#state.status !== 'ready') return
      const message = error instanceof Error ? error.message : String(error)
      const current = this.#assetScreen()
      if (current !== undefined) {
        this.#setReadyScreen({
          ...current,
          phase: current.phase === 'stale' ? 'stale' : 'error',
          message: current.phase === 'stale'
            ? `提交使用的 revision 已过期；重新读取失败：${message}`
            : message,
        }, {
          kind: error instanceof NovelWorkbenchDisconnectedError ? 'disconnected' : 'error',
          message: error instanceof NovelWorkbenchDisconnectedError
            ? '读取失败：Harness 连接已断开。'
            : `读取失败：${message}`,
        })
      } else {
        this.#setReadyScreen({ kind: 'asset-error', target, message })
      }
    }
  }

  async #runRead(reason: 'open' | 'inspect' | 'refresh'): Promise<void> {
    if (this.#disposed) return
    const target = this.#target
    if (target === undefined) {
      this.#set({ status: 'empty', open: this.#state.open })
      return
    }
    const request = ++this.#request
    const previous = this.#activeRead
    previous?.abort.abort()
    const feedback: NovelReadFeedback = {
      kind: 'loading',
      message: reason === 'refresh' ? '正在重新读取小说项目…' : '正在读取小说项目状态…',
    }
    this.#set(reason === 'refresh' && this.#state.status === 'not-initialized'
      ? { ...this.#state, readFeedback: feedback }
      : { status: 'loading', open: this.#state.open, readFeedback: feedback })
    await previous?.done
    if (this.#disposed || request !== this.#request) return
    const abort = new AbortController()
    const done = this.#settleRead(request, target, abort.signal)
    const active = { abort, done }
    this.#activeRead = active
    await done
    if (this.#activeRead === active) this.#activeRead = undefined
    const generatedInitialization = this.#initializationGeneration
    if (this.#disposed
      || this.#state.status !== 'ready'
      || generatedInitialization.phase !== 'reconciling'
      || generatedInitialization.expectedRevision === undefined) return
    await this.#startAssetRead({ kind: 'project' }, 'open')
    const project = this.#assetScreen()
    if (project?.kind !== 'project') return
    this.#initializationGeneration = { brief: '', phase: 'editing' }
    this.#generationCorrelationMarker = undefined
    if (project.baseRevision !== generatedInitialization.expectedRevision) {
      this.#setReadyScreen({
        ...project,
        generation: {
          brief: generatedInitialization.brief,
          phase: 'error',
          message: '项目已初始化，但磁盘 revision 与本次模型生成回执不一致。请核对对话中的工具结果。',
        },
      })
      return
    }
    const message = `模型生成已批准并载入 revision ${project.baseRevision.slice(0, 12)}；上方字段是磁盘中的最终内容。`
    this.#setReadyScreen({
      ...project,
      generation: {
        brief: generatedInitialization.brief,
        phase: 'applied',
        message,
        expectedRevision: project.baseRevision,
        expectedReplacement: project.originalText,
      },
    }, { kind: 'success', message })
  }

  async #settleRead(request: number, target: NovelWorkbenchTarget, signal: AbortSignal): Promise<void> {
    try {
      const result = await this.#port.read(target.workspaceId, this.#chapter, signal)
      if (this.#disposed || request !== this.#request) return
      if (result.status === 'not-initialized' && this.#initializationGeneration.phase === 'reconciling') {
        this.#initializationGeneration = {
          ...this.#initializationGeneration,
          phase: 'error',
          message: this.#initializationGeneration.expectedRevision === undefined
            ? '模型轮次未产生可归因的初始化；项目仍未初始化。可以修改要求后重试。'
            : '工具报告初始化成功，但权威读取仍显示项目未初始化。请先检查对话中的工具结果。',
        }
      }
      this.#set(result.status === 'ready'
        ? {
            ...result,
            open: this.#state.open,
            screen: { kind: 'root' },
            ...(submissionBlocker(this.#target) === undefined
              ? {}
              : { submissionBlocker: submissionBlocker(this.#target) }),
            readFeedback: { kind: 'success', message: '读取完成：小说项目已初始化。' },
          }
        : {
            status: 'not-initialized',
            open: this.#state.open,
            initialization: {
              draft: this.#draft,
              phase: this.#state.status === 'not-initialized'
                && this.#state.initialization.phase === 'submitted'
                ? 'submitted'
                : this.#activePrompt === undefined ? 'editing' : 'submitting',
              generation: this.#initializationGeneration,
              ...(this.#state.status === 'not-initialized'
                && this.#state.initialization.preview !== undefined
                ? { preview: this.#state.initialization.preview }
                : {}),
              ...(submissionBlocker(this.#target) === undefined ? {} : { blocker: submissionBlocker(this.#target) }),
            },
            readFeedback: { kind: 'success', message: '读取完成：当前工作区尚未初始化小说项目。' },
          })
    } catch (error) {
      if (this.#disposed || request !== this.#request) return
      if (error instanceof NovelWorkbenchDisconnectedError) {
        this.#set({
          status: 'disconnected',
          open: this.#state.open,
          readFeedback: { kind: 'disconnected', message: '读取失败：Harness 连接已断开。' },
        })
      } else {
        const message = error instanceof Error ? error.message : String(error)
        this.#set({
          status: 'error',
          open: this.#state.open,
          message,
          readFeedback: { kind: 'error', message: `读取失败：${message}` },
        })
      }
    }
  }

  async #submit(request: number, sessionId: SessionId, text: string): Promise<void> {
    try {
      const result = await this.#port.prompt(sessionId, text)
      if (this.#disposed || request !== this.#promptRequest) return
      if (result.ok) {
        this.#setInitializationPhase('submitted')
      } else {
        this.#setInitializationError(`初始化提案未发送：${result.error.code}: ${result.error.message}`)
      }
    } catch (error) {
      if (!this.#disposed && request === this.#promptRequest) {
        this.#setInitializationError(`初始化提案未发送：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  async #submitAsset(request: number, sessionId: SessionId, text: string): Promise<void> {
    try {
      const result = await this.#port.prompt(sessionId, text)
      if (this.#disposed || request !== this.#promptRequest) return
      const screen = this.#assetScreen()
      if (screen === undefined) return
      this.#setReadyScreen(result.ok
        ? { ...screen, phase: 'submitted', message: '修改提案已发送；磁盘仍未改变，等待 Harness 原生审批。' }
        : { ...screen, phase: 'error', message: `修改提案未发送：${result.error.code}: ${result.error.message}` })
    } catch (error) {
      if (this.#disposed || request !== this.#promptRequest) return
      const screen = this.#assetScreen()
      if (screen !== undefined) {
        this.#setReadyScreen({
          ...screen,
          phase: 'error',
          message: `修改提案未发送：${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }
  }

  async #submitGeneration(request: number, sessionId: SessionId, text: string): Promise<void> {
    try {
      const result = await this.#port.prompt(sessionId, text)
      if (this.#disposed || request !== this.#promptRequest) return
      const screen = this.#assetScreen()
      if (screen === undefined) return
      const generation = generationState(screen)
      this.#setReadyScreen({
        ...screen,
        generation: result.ok
          ? generation.phase === 'reconciling'
            ? generation
            : { ...generation, phase: 'submitted', message: '生成请求已发送；等待模型提案与 Harness 原生审批。' }
          : { ...generation, phase: 'error', message: `生成请求未发送：${result.error.code}: ${result.error.message}` },
      })
    } catch (error) {
      if (this.#disposed || request !== this.#promptRequest) return
      const screen = this.#assetScreen()
      if (screen !== undefined) {
        const generation = generationState(screen)
        this.#setReadyScreen({
          ...screen,
          generation: {
            ...generation,
            phase: 'error',
            message: `生成请求未发送：${error instanceof Error ? error.message : String(error)}`,
          },
        })
      }
    }
  }

  async #submitInitializationGeneration(request: number, sessionId: SessionId, text: string): Promise<void> {
    try {
      const result = await this.#port.prompt(sessionId, text)
      if (this.#disposed || request !== this.#promptRequest) return
      this.#initializationGeneration = result.ok
        ? this.#initializationGeneration.phase === 'reconciling'
          ? this.#initializationGeneration
          : { ...this.#initializationGeneration, phase: 'submitted', message: '生成请求已发送；等待模型提案与 Harness 原生审批。' }
        : { ...this.#initializationGeneration, phase: 'error', message: `生成请求未发送：${result.error.code}: ${result.error.message}` }
      this.#publishInitializationGeneration()
    } catch (error) {
      if (this.#disposed || request !== this.#promptRequest) return
      this.#initializationGeneration = {
        ...this.#initializationGeneration, phase: 'error',
        message: `生成请求未发送：${error instanceof Error ? error.message : String(error)}`,
      }
      this.#publishInitializationGeneration()
    }
  }

  #resetStalePromptState(request: number): void {
    if (!this.#disposed
      && request !== this.#promptRequest
      && this.#state.status === 'not-initialized'
      && this.#state.initialization.phase === 'submitting') {
      this.#setInitializationPhase('editing')
    }
  }

  #setInitializationPhase(phase: NovelInitializationPhase, preview?: NovelInitializationPreview): void {
    const retainedPreview = preview
      ?? (this.#state.status === 'not-initialized' ? this.#state.initialization.preview : undefined)
    this.#set({
      status: 'not-initialized',
      open: this.#state.open,
      initialization: {
        draft: this.#draft,
        phase,
        generation: this.#initializationGeneration,
        ...(retainedPreview === undefined ? {} : { preview: retainedPreview }),
        ...(submissionBlocker(this.#target) === undefined ? {} : { blocker: submissionBlocker(this.#target) }),
      },
      ...(this.#state.readFeedback === undefined ? {} : { readFeedback: this.#state.readFeedback }),
    })
  }

  #setInitializationError(message: string): void {
    const preview = this.#state.status === 'not-initialized' ? this.#state.initialization.preview : undefined
    this.#set({
      status: 'not-initialized',
      open: this.#state.open,
      initialization: {
        draft: this.#draft,
        phase: 'error',
        message,
        generation: this.#initializationGeneration,
        ...(preview === undefined ? {} : { preview }),
        ...(submissionBlocker(this.#target) === undefined ? {} : { blocker: submissionBlocker(this.#target) }),
      },
      ...(this.#state.readFeedback === undefined ? {} : { readFeedback: this.#state.readFeedback }),
    })
  }

  #publishInitializationGeneration(): void {
    if (this.#state.status !== 'not-initialized') return
    this.#set({
      ...this.#state,
      initialization: { ...this.#state.initialization, generation: this.#initializationGeneration },
    })
  }

  #loadAsset(result: NovelAssetReadWireResult, feedback?: NovelReadFeedback): void {
    if (this.#state.status !== 'ready') return
    switch (result.target.kind) {
      case 'project': {
        const source = parseProjectManifest(result.text)
        const draft = projectDraft(source)
        const plannedChapters = Number(source.plannedChapters)
        const selectedChapter = Math.min(this.#state.progress.selectedChapter, plannedChapters)
        const retainedChapter = selectedChapter === this.#state.progress.selectedChapter
        this.#chapter = selectedChapter
        this.#projectSource = source
        this.#projectOriginal = draft
        this.#set({
          ...this.#state,
          project: {
            ...this.#state.project,
            title: source.title,
            language: source.language,
            genre: source.genre,
            plannedChapters,
            targetWordsPerChapter: Number(source.targetWordsPerChapter),
            creativeStrategy: source.creativeStrategy,
            updatedAt: source.updatedAt,
          },
          progress: retainedChapter
            ? { ...this.#state.progress, plannedChapters, selectedChapter }
            : {
                selectedChapter, plannedChapters, status: 'unplanned',
                draftPresent: false, draftBytes: 0,
              },
          chapterBlueprint: retainedChapter ? this.#state.chapterBlueprint : null,
          draft: retainedChapter ? this.#state.draft : null,
          screen: {
            kind: 'project',
            phase: 'clean',
            dirty: false,
            baseRevision: result.revision,
            originalText: result.text,
            summary: '',
            generation: { brief: '', phase: 'editing' },
            draft,
          },
          ...(feedback === undefined ? {} : { readFeedback: feedback }),
        })
        return
      }
      case 'characters': {
        const characters = parseCharacters(result.text, result.revision)
        this.#charactersOriginal = characters
        this.#set({
          ...this.#state,
          characters: characters.map(({ id, name, role, summary }) => ({ id, name, role, summary })),
          screen: {
            kind: 'characters',
            phase: 'clean',
            dirty: false,
            baseRevision: result.revision,
            originalText: result.text,
            summary: '',
            generation: { brief: '', phase: 'editing' },
            characters,
            selectedId: characters[0]?.id,
            search: '',
            visibleCharacterIds: characters.map(character => character.id),
          },
          ...(feedback === undefined ? {} : { readFeedback: feedback }),
        })
        return
      }
      case 'story-blueprint': {
        const draft = parseStoryBlueprint(result.text, result.revision)
        this.#storyOriginal = draft
        this.#set({
          ...this.#state,
          storyBlueprint: result.revision === 'absent' ? null : {
            premise: draft.premise,
            themes: draft.themesText === '' ? [] : draft.themesText.split('\n'),
            world: draft.world,
            mainPlot: draft.mainPlot,
            endingGoal: draft.endingGoal,
          },
          screen: {
            kind: 'story-blueprint',
            phase: 'clean',
            dirty: false,
            baseRevision: result.revision,
            originalText: result.text,
            summary: '',
            generation: { brief: '', phase: 'editing' },
            draft,
          },
          ...(feedback === undefined ? {} : { readFeedback: feedback }),
        })
        return
      }
      case 'chapter-blueprint': {
        const draft = parseChapterBlueprint(result.text, result.revision, result.target.chapter)
        const retainedChapter = this.#state.progress.selectedChapter === result.target.chapter
        this.#chapter = result.target.chapter
        this.#chapterBlueprintOriginal = draft
        this.#set({
          ...this.#state,
          progress: {
            ...this.#state.progress,
            selectedChapter: result.target.chapter,
            status: result.revision === 'absent' ? 'unplanned' : draft.status,
            draftPresent: retainedChapter ? this.#state.progress.draftPresent : false,
            draftBytes: retainedChapter ? this.#state.progress.draftBytes : 0,
          },
          chapterBlueprint: result.revision === 'absent' ? null : {
            chapter: result.target.chapter,
            title: draft.title,
            purpose: draft.purpose,
            beats: linesFromDraft(draft.beatsText),
            characterIds: linesFromDraft(draft.characterIdsText),
            continuityNotes: linesFromDraft(draft.continuityNotesText),
            status: draft.status,
          },
          draft: retainedChapter ? this.#state.draft : null,
          screen: {
            kind: 'chapter-blueprint',
            chapter: result.target.chapter,
            phase: 'clean',
            dirty: false,
            baseRevision: result.revision,
            originalText: result.text,
            summary: '',
            generation: { brief: '', phase: 'editing' },
            draft,
          },
          ...(feedback === undefined ? {} : { readFeedback: feedback }),
        })
        return
      }
      case 'chapter-draft': {
        const text = serializeChapterDraft(result.text)
        const retainedChapter = this.#state.progress.selectedChapter === result.target.chapter
        this.#chapter = result.target.chapter
        this.#chapterDraftOriginal = text
        this.#set({
          ...this.#state,
          progress: {
            ...this.#state.progress,
            selectedChapter: result.target.chapter,
            status: retainedChapter ? this.#state.progress.status : 'unplanned',
            draftPresent: result.revision !== 'absent',
            draftBytes: result.bytes,
          },
          chapterBlueprint: retainedChapter ? this.#state.chapterBlueprint : null,
          draft: result.revision === 'absent' ? null : {
            revision: result.revision,
            preview: text,
            bytes: result.bytes,
            truncated: false,
          },
          screen: {
            kind: 'chapter-draft',
            chapter: result.target.chapter,
            phase: 'clean',
            dirty: false,
            baseRevision: result.revision,
            originalText: result.text,
            summary: '',
            generation: { brief: '', phase: 'editing' },
            text,
          },
          ...(feedback === undefined ? {} : { readFeedback: feedback }),
        })
        return
      }
      default: throw new Error('Asset is not editable in this workbench slice')
    }
  }

  #setCharactersDraft(
    screen: NovelCharactersEditorScreen,
    characters: readonly NovelCharacterDraft[],
    selectedId: string | undefined,
  ): void {
    const dirty = this.#charactersOriginal !== undefined && !sameCharacters(characters, this.#charactersOriginal)
    this.#setReadyScreen({
      ...screen,
      characters,
      selectedId,
      visibleCharacterIds: visibleCharacterIds(characters, screen.search),
      dirty,
      phase: dirty ? 'editing' : 'clean',
      replacement: undefined,
      preview: undefined,
      message: undefined,
      generation: generationAfterAssetEdit(screen),
    })
  }

  #requiredProjectSource(): ProjectManifestEditorSource {
    if (this.#projectSource === undefined) throw new Error('项目设置原始内容不可用')
    return this.#projectSource
  }

  #assetMayChange(screen: NovelAssetEditorScreen): boolean {
    return this.#activePrompt === undefined
      && !generationBlocksMutation(screen)
      && screen.phase !== 'submitted'
      && screen.phase !== 'submitting'
      && screen.phase !== 'stale'
  }

  #projectScreen(): NovelProjectEditorScreen | undefined {
    const screen = this.#state.status === 'ready' ? this.#state.screen : undefined
    return screen?.kind === 'project' ? screen : undefined
  }

  #charactersScreen(): NovelCharactersEditorScreen | undefined {
    const screen = this.#state.status === 'ready' ? this.#state.screen : undefined
    return screen?.kind === 'characters' ? screen : undefined
  }

  #storyScreen(): NovelStoryBlueprintEditorScreen | undefined {
    const screen = this.#state.status === 'ready' ? this.#state.screen : undefined
    return screen?.kind === 'story-blueprint' ? screen : undefined
  }

  #chapterBlueprintScreen(): NovelChapterBlueprintEditorScreen | undefined {
    const screen = this.#state.status === 'ready' ? this.#state.screen : undefined
    return screen?.kind === 'chapter-blueprint' ? screen : undefined
  }

  #chapterDraftScreen(): NovelChapterDraftEditorScreen | undefined {
    const screen = this.#state.status === 'ready' ? this.#state.screen : undefined
    return screen?.kind === 'chapter-draft' ? screen : undefined
  }

  #assetScreen(): NovelAssetEditorScreen | undefined {
    return this.#projectScreen()
      ?? this.#charactersScreen()
      ?? this.#storyScreen()
      ?? this.#chapterBlueprintScreen()
      ?? this.#chapterDraftScreen()
  }

  #screenTarget(screen: NovelAssetEditorScreen): NovelWorkbenchEditableTarget {
    return screen.kind === 'chapter-blueprint' || screen.kind === 'chapter-draft'
      ? { kind: screen.kind, chapter: screen.chapter }
      : { kind: screen.kind }
  }

  #setReadyScreen(screen: NovelWorkbenchScreen, readFeedback?: NovelReadFeedback): void {
    if (this.#state.status !== 'ready') return
    this.#set({
      ...this.#state,
      screen,
      ...(readFeedback === undefined
        ? {}
        : { readFeedback }),
    })
  }

  #cancelRead(): void {
    this.#request += 1
    this.#activeRead?.abort.abort()
  }

  #set(state: NovelWorkbenchState): void {
    this.#state = state
    for (const listener of this.#listeners) {
      try {
        listener()
      } catch (error) {
        try {
          this.#reportListenerError(error)
        } catch (reportingError) {
          // Reporting is best-effort so a broken sink cannot starve healthy subscribers.
          void reportingError
        }
      }
    }
  }
}
