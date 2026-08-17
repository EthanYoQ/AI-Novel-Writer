/** Error emitted when the browser has no live Host connection. */
export class PresetSetupDisconnectedError extends Error {
  /**
   * Create a stable disconnected error.
   *
   * @param cause Optional transport failure.
   */
  public constructor(cause?: unknown) {
    super('Host connection is unavailable', cause === undefined ? undefined : { cause })
    this.name = 'PresetSetupDisconnectedError'
  }
}

/** RPC operations required by the preset setup controller. */
export interface PresetSetupPort {
  /**
   * @param signal Cancellation signal for the Host transport and inspection.
   * @returns Current Host-side preset state.
   * @throws When transport or response validation fails, or the signal is aborted.
   */
  status(signal: AbortSignal): Promise<{ readonly status: 'not-installed' | 'installed' | 'conflict' }>
  /**
   * @param signal Cancellation signal honored before Host publication.
   * @returns Result of an explicit Host-side installation attempt.
   * @throws When transport, response validation, or installation fails, or the signal is aborted.
   */
  install(signal: AbortSignal): Promise<{ readonly status: 'installed' | 'conflict'; readonly changed: boolean }>
}

/** Complete client state rendered by the preset setup surface. */
export type PresetSetupState =
  | { readonly status: 'idle' | 'loading' | 'not-installed' | 'conflict' | 'disconnected'; readonly open: boolean }
  | { readonly status: 'installed'; readonly open: boolean; readonly changed: boolean }
  | { readonly status: 'error'; readonly open: boolean; readonly message: string }

/** Framework-independent preset setup state controller. */
export class PresetSetupController {
  readonly #listeners = new Set<() => void>()
  readonly #port: PresetSetupPort
  readonly #reportListenerError: (error: unknown) => void
  #state: PresetSetupState = { status: 'idle', open: false }
  #request = 0
  #active: { readonly abort: AbortController; readonly done: Promise<void> } | undefined
  #disposed = false

  /**
   * Create a controller over one Host RPC port.
   *
   * @param port RPC operations used for inspection and explicit installation.
   * @param reportListenerError Error sink for isolated render subscriber failures.
   */
  public constructor(port: PresetSetupPort, reportListenerError: (error: unknown) => void) {
    this.#port = port
    this.#reportListenerError = reportListenerError
  }

  /** @returns The current immutable render state. */
  public getSnapshot(): PresetSetupState {
    return this.#state
  }

  /**
   * Subscribe to state changes.
   *
   * @param listener Callback invoked after each state transition.
   * @returns A disposer that removes the subscription.
   */
  public subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** @returns Nothing. */
  public open(): void {
    if (this.#disposed) return
    this.#set({ ...this.#state, open: true })
  }

  /** @returns Nothing. */
  public close(): void {
    if (this.#disposed) return
    this.#set({ ...this.#state, open: false })
  }

  /**
   * Abort the current request and expose the disconnected state without waiting for settlement.
   *
   * @returns Nothing.
   */
  public disconnected(): void {
    if (this.#disposed) return
    this.#request += 1
    this.#active?.abort.abort()
    this.#set({ status: 'disconnected', open: this.#state.open })
  }

  /**
   * Abort and await the previous request before loading Host installation state.
   * Transport and response failures become error or disconnected state instead of rejection.
   *
   * @returns Completion after the Host installation state has been loaded.
   */
  public async load(): Promise<void> {
    await this.#run(async signal => {
      const result = await this.#port.status(signal)
      return result.status === 'installed'
        ? { status: 'installed', open: this.#state.open, changed: false }
        : { status: result.status, open: this.#state.open }
    })
  }

  /**
   * Abort and await the previous request before starting an explicit Host installation.
   * Transport, validation, and installation failures become error or disconnected state instead of rejection.
   *
   * @returns Completion after the explicit Host installation request settles.
   */
  public async install(): Promise<void> {
    await this.#run(async signal => {
      const result = await this.#port.install(signal)
      return result.status === 'installed'
        ? { status: 'installed', open: this.#state.open, changed: result.changed }
        : { status: 'conflict', open: this.#state.open }
    })
  }

  /**
   * Stop publishing state, abort the active Host request, and wait until it settles.
   *
   * @returns Completion after in-flight work reaches quiescence.
   */
  public async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#request += 1
    this.#listeners.clear()
    const active = this.#active
    active?.abort.abort()
    await active?.done
    if (this.#active === active) this.#active = undefined
  }

  async #run(operation: (signal: AbortSignal) => Promise<PresetSetupState>): Promise<void> {
    if (this.#disposed) return
    const request = ++this.#request
    const previous = this.#active
    previous?.abort.abort()
    this.#set({ status: 'loading', open: this.#state.open })
    await previous?.done
    if (this.#disposed || request !== this.#request) return

    const abort = new AbortController()
    const done = this.#settle(request, abort.signal, operation)
    const active = { abort, done }
    this.#active = active
    await done
    if (this.#active === active) this.#active = undefined
  }

  async #settle(
    request: number,
    signal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<PresetSetupState>,
  ): Promise<void> {
    try {
      const state = await operation(signal)
      if (!this.#disposed && request === this.#request) this.#set(state)
    } catch (error) {
      if (!this.#disposed && request === this.#request) this.#setError(error)
    }
  }

  #setError(error: unknown): void {
    this.#set(error instanceof PresetSetupDisconnectedError
      ? { status: 'disconnected', open: this.#state.open }
      : { status: 'error', open: this.#state.open, message: error instanceof Error ? error.message : String(error) })
  }

  #set(state: PresetSetupState): void {
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
