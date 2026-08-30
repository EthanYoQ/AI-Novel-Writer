export interface SingleInstanceWindow {
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
}

export interface SingleInstanceRuntimeOptions {
  releaseSmokeRequested: boolean
  requestLock(): boolean
  quit(): void
  onSecondInstance(listener: () => void): void
  getWindow(): SingleInstanceWindow | null | undefined
}

export function focusExistingInstance(window: SingleInstanceWindow | null | undefined): void {
  if (!window || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

/**
 * Release qualification processes deliberately bypass the interactive lock so
 * architecture-specific smoke jobs can run independently. Ordinary launches
 * are single-instance and the second process exits before startup work begins.
 */
export function configureSingleInstanceRuntime(options: SingleInstanceRuntimeOptions): boolean {
  if (options.releaseSmokeRequested) return true
  if (!options.requestLock()) {
    options.quit()
    return false
  }
  options.onSecondInstance(() => focusExistingInstance(options.getWindow()))
  return true
}
