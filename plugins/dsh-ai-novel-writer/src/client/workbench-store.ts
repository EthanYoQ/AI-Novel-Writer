/** Framework-independent state and orchestration for the compact novel workbench. */

import type { SessionId, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type { NovelContextReadResult, NovelContextReady } from '../context-types.ts'
import type { CreativeStrategy, NovelProjectId } from '../types.ts'

/** Dedicated Preset id expected on a Session that receives novel proposals. */
export const AI_NOVEL_PRESET_ID = 'ai-novel-writer'

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
  | (NovelContextReady & NovelWorkbenchStateBase)
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
  #state: NovelWorkbenchState = { status: 'idle', open: false }
  #target: NovelWorkbenchTarget | undefined
  #draft: NovelInitializationDraft = DEFAULT_INITIALIZATION
  #chapter = 1
  #request = 0
  #promptRequest = 0
  #activeRead: { readonly abort: AbortController; readonly done: Promise<void> } | undefined
  #activePrompt: Promise<void> | undefined
  #latest: Promise<void> = Promise.resolve()
  #disposed = false

  /**
   * @param port Closed context-read and Session-prompt operations.
   * @param reportListenerError Error sink for isolated render subscriber failures.
   * @param createIdentity Identity factory invoked only after local form validation succeeds.
   */
  public constructor(
    port: NovelWorkbenchPort,
    reportListenerError: (error: unknown) => void,
    createIdentity: () => NovelInitializationIdentity = defaultIdentity,
  ) {
    this.#port = port
    this.#reportListenerError = reportListenerError
    this.#createIdentity = createIdentity
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
   * Select and read one planned chapter while the workbench is open.
   *
   * @param chapter One-based chapter number within the loaded project plan.
   * @returns Completion after the read settles, or immediately while closed.
   * @throws {RangeError} When the selection is not a positive integer or exceeds the loaded plan.
   */
  public selectChapter(chapter: number): Promise<void> {
    const planned = this.#state.status === 'ready' ? this.#state.project.plannedChapters : undefined
    if (!Number.isSafeInteger(chapter) || chapter <= 0 || (planned !== undefined && chapter > planned)) {
      throw new RangeError('chapter selection is outside the project plan')
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
    if (this.#activePrompt !== undefined || this.#state.initialization.phase === 'submitting') return
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
    return this.#state.open ? this.#startRead('refresh') : Promise.resolve()
  }

  /** Abort the active read and expose disconnected state without waiting for settlement. @returns Nothing. */
  public disconnected(): void {
    if (this.#disposed) return
    this.#promptRequest += 1
    this.#cancelRead()
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
    this.#set({
      status: 'loading',
      open: this.#state.open,
      readFeedback: {
        kind: 'loading',
        message: reason === 'refresh' ? '正在重新读取小说项目…' : '正在读取小说项目状态…',
      },
    })
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
            readFeedback: { kind: 'success', message: '读取完成：小说项目已初始化。' },
          }
        : {
            status: 'not-initialized',
            open: this.#state.open,
            initialization: {
              draft: this.#draft,
              phase: this.#activePrompt === undefined ? 'editing' : 'submitting',
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
