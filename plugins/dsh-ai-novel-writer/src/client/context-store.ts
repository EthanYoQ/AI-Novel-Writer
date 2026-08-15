/** Framework-independent state for the read-only novel context window. */

import type { SessionId, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type { NovelContextReadResult, NovelContextReady } from '../context-types.ts'

export type { NovelContextReady } from '../context-types.ts'

/** Error emitted when the browser has no live Host connection. */
export class NovelContextDisconnectedError extends Error {
  /**
   * @param cause Optional transport failure.
   */
  public constructor(cause?: unknown) {
    super('Host connection is unavailable', cause === undefined ? undefined : { cause })
    this.name = 'NovelContextDisconnectedError'
  }
}

/** Closed read operation required by the context controller. */
export interface NovelContextPort {
  /**
   * @param workspaceId Opaque Workspace registry identity, never a local path.
   * @param chapter Selected one-based chapter number.
   * @param signal Cancellation signal for the Host transport and filesystem reads.
   * @returns Bounded context or an explicit uninitialized result.
   * @throws When transport, response validation, project reading, or cancellation fails.
   */
  read(workspaceId: WorkspaceId, chapter: number, signal: AbortSignal): Promise<NovelContextReadResult>
}

/** Current Workspace and Session identity selected in the Harness shell. */
export interface NovelContextTarget {
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
}

/** Complete render state for the context window. */
export type NovelContextState =
  | { readonly status: 'idle' | 'empty' | 'loading' | 'not-initialized' | 'disconnected'; readonly open: boolean }
  | ({ readonly open: boolean } & NovelContextReady)
  | { readonly status: 'error'; readonly open: boolean; readonly message: string }

/** Read-only context controller with abort-on-supersede and quiescent disposal. */
export class NovelContextController {
  readonly #listeners = new Set<() => void>()
  readonly #port: NovelContextPort
  readonly #reportListenerError: (error: unknown) => void
  #state: NovelContextState = { status: 'idle', open: false }
  #target: NovelContextTarget | undefined
  #chapter = 1
  #request = 0
  #active: { readonly abort: AbortController; readonly done: Promise<void> } | undefined
  #latest: Promise<void> = Promise.resolve()
  #disposed = false

  /**
   * @param port Closed Host read operation.
   * @param reportListenerError Error sink for isolated render subscriber failures.
   */
  public constructor(port: NovelContextPort, reportListenerError: (error: unknown) => void) {
    this.#port = port
    this.#reportListenerError = reportListenerError
  }

  /** @returns Current immutable render state. */
  public getSnapshot(): NovelContextState {
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
   * Update the opaque shell selection. A changed target resets chapter selection and refreshes only while open.
   *
   * @param target Current Workspace and Session, or absent when no registered Workspace owns the selection.
   * @returns Nothing; use {@link whenIdle} when a caller must await the triggered refresh.
   */
  public setTarget(target: NovelContextTarget | undefined): void {
    if (this.#disposed) return
    if (target?.workspaceId === this.#target?.workspaceId && target?.sessionId === this.#target?.sessionId) return
    this.#target = target
    this.#chapter = 1
    if (target === undefined) {
      this.#cancel()
      this.#set({ status: 'empty', open: this.#state.open })
    } else if (this.#state.open) {
      void this.#start()
    }
  }

  /**
   * Open the window and load the selected Workspace when present.
   *
   * @returns Completion after the initial read settles.
   */
  public open(): Promise<void> {
    if (this.#disposed) return Promise.resolve()
    this.#set({ ...this.#state, open: true })
    return this.#start()
  }

  /** @returns Nothing. */
  public close(): void {
    if (this.#disposed) return
    this.#set({ ...this.#state, open: false })
  }

  /**
   * Select and read one planned chapter while the window is open.
   *
   * @param chapter One-based chapter number within the current project plan.
   * @returns Completion after the read settles, or immediately while closed.
   * @throws {RangeError} When the selection is not a positive integer or exceeds the loaded plan.
   */
  public selectChapter(chapter: number): Promise<void> {
    const planned = this.#state.status === 'ready' ? this.#state.project.plannedChapters : undefined
    if (!Number.isSafeInteger(chapter) || chapter <= 0 || (planned !== undefined && chapter > planned)) {
      throw new RangeError('chapter selection is outside the project plan')
    }
    this.#chapter = chapter
    return this.#state.open ? this.#start() : Promise.resolve()
  }

  /**
   * Refresh the current target after explicit user action, reconnect, or relevant session activity.
   *
   * @returns Completion after the read settles, or immediately while closed.
   */
  public refresh(): Promise<void> {
    return this.#state.open ? this.#start() : Promise.resolve()
  }

  /**
   * Abort the active request and expose disconnected state without waiting for settlement.
   *
   * @returns Nothing.
   */
  public disconnected(): void {
    if (this.#disposed) return
    this.#cancel()
    this.#set({ status: 'disconnected', open: this.#state.open })
  }

  /**
   * Wait for target-triggered work, including a refresh queued behind a superseded read.
   *
   * @returns Completion when the latest known read settles.
   */
  public async whenIdle(): Promise<void> {
    let latest: Promise<void>
    do {
      latest = this.#latest
      await latest
    } while (latest !== this.#latest)
  }

  /**
   * Stop publishing state, abort the active Host read, and wait until all triggered work settles.
   *
   * @returns Completion after in-flight work reaches quiescence.
   */
  public async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#listeners.clear()
    this.#cancel()
    await this.whenIdle()
  }

  #start(): Promise<void> {
    const latest = this.#run()
    this.#latest = latest
    return latest
  }

  async #run(): Promise<void> {
    if (this.#disposed) return
    const target = this.#target
    if (target === undefined) {
      this.#set({ status: 'empty', open: this.#state.open })
      return
    }
    const chapter = this.#chapter
    const request = ++this.#request
    const previous = this.#active
    previous?.abort.abort()
    this.#set({ status: 'loading', open: this.#state.open })
    await previous?.done
    if (this.#disposed || request !== this.#request) return

    const abort = new AbortController()
    const done = this.#settle(request, target, chapter, abort.signal)
    const active = { abort, done }
    this.#active = active
    await done
    if (this.#active === active) this.#active = undefined
  }

  async #settle(
    request: number,
    target: NovelContextTarget,
    chapter: number,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const result = await this.#port.read(target.workspaceId, chapter, signal)
      if (this.#disposed || request !== this.#request) return
      this.#set(result.status === 'ready'
        ? { ...result, open: this.#state.open }
        : { status: 'not-initialized', open: this.#state.open })
    } catch (error) {
      if (this.#disposed || request !== this.#request) return
      this.#set(error instanceof NovelContextDisconnectedError
        ? { status: 'disconnected', open: this.#state.open }
        : { status: 'error', open: this.#state.open, message: error instanceof Error ? error.message : String(error) })
    }
  }

  #cancel(): void {
    this.#request += 1
    this.#active?.abort.abort()
  }

  #set(state: NovelContextState): void {
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
