/** Framework-independent state and orchestration for the compact novel workbench. */

import type { SessionId, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type { NovelAssetReadWireResult, NovelContextReadResult, NovelContextReady } from '../context-types.ts'
import type { CreativeStrategy, NovelProjectId } from '../types.ts'
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
  NovelProjectEditorScreen,
  NovelProjectSettingsDraft,
  NovelStoryBlueprintDraft,
  NovelStoryBlueprintEditorScreen,
  NovelWorkbenchEditableTarget,
  NovelWorkbenchScreen,
} from './asset-editor.ts'

/** Dedicated Preset id expected on a Session that receives novel proposals. */
export const AI_NOVEL_PRESET_ID = 'ai-novel-writer'

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
   * @param text Deterministic proposal prompt submitted as an ordinary queued turn.
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
  | (NovelContextReady & NovelWorkbenchStateBase & { readonly screen: NovelWorkbenchScreen })
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
    if (this.#activePrompt !== undefined || this.#state.initialization.phase === 'submitted') return
    this.#draft = { ...this.#draft, ...patch }
    this.#set({
      status: 'not-initialized',
      open: this.#state.open,
      initialization: {
        draft: this.#draft,
        phase: 'editing',
        ...(submissionBlocker(this.#target) === undefined ? {} : { blocker: submissionBlocker(this.#target) }),
      },
      ...(this.#state.readFeedback === undefined ? {} : { readFeedback: this.#state.readFeedback }),
    })
  }

  /**
   * Validate the current draft and expose the exact values that a later Session prompt will carry.
   *
   * @returns Nothing; validation failures are published in initialization state and pending submissions are unchanged.
   */
  public previewInitialization(): void {
    if (this.#disposed || this.#state.status !== 'not-initialized') return
    if (this.#activePrompt !== undefined || this.#state.initialization.phase === 'submitted') return
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
      || screen.phase === 'stale')) return
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
   * @param id Optional caller-selected id; otherwise a UUID is generated.
   * @returns Nothing; duplicate ids are rejected and submitted editors are unchanged.
   */
  public createCharacter(id: string = crypto.randomUUID()): void {
    const screen = this.#charactersScreen()
    if (screen === undefined || !this.#assetMayChange(screen)) return
    const normalizedId = id.trim()
    if (normalizedId === '' || screen.characters.some(character => character.id === normalizedId)) {
      this.#setReadyScreen({ ...screen, phase: 'error', message: '人物 ID 不能为空或重复。' })
      return
    }
    const characters = [...screen.characters, {
      id: normalizedId,
      name: '',
      role: '',
      summary: '',
      goal: '',
      relationshipsText: '',
      notes: '',
    }]
    this.#setCharactersDraft(screen, characters, normalizedId)
  }

  /**
   * Update the selected character record.
   *
   * @param patch Editable character fields.
   * @returns Nothing; changes are ignored without a selection or during prompt admission.
   */
  public updateCharacter(patch: Partial<NovelCharacterDraft>): void {
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
      const prompt = assetProposalPrompt(target, screen.baseRevision, screen.originalText, replacement, screen.summary)
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
      || this.#state.initialization.phase === 'submitted') return
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
        this.#setReadyScreen({
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
  }

  async #settleRead(request: number, target: NovelWorkbenchTarget, signal: AbortSignal): Promise<void> {
    try {
      const result = await this.#port.read(target.workspaceId, this.#chapter, signal)
      if (this.#disposed || request !== this.#request) return
      this.#set(result.status === 'ready'
        ? {
            ...result,
            open: this.#state.open,
            screen: { kind: 'root' },
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
        ...(preview === undefined ? {} : { preview }),
        ...(submissionBlocker(this.#target) === undefined ? {} : { blocker: submissionBlocker(this.#target) }),
      },
      ...(this.#state.readFeedback === undefined ? {} : { readFeedback: this.#state.readFeedback }),
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
    })
  }

  #requiredProjectSource(): ProjectManifestEditorSource {
    if (this.#projectSource === undefined) throw new Error('项目设置原始内容不可用')
    return this.#projectSource
  }

  #assetMayChange(screen: NovelAssetEditorScreen): boolean {
    return this.#activePrompt === undefined
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
