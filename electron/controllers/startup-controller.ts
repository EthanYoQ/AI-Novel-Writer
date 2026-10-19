import { APPEARANCE_STORAGE_KEY } from '../../src/shared/appearance-profile'
import type { StartupState, StartupMigrationNotice, StartupBlockedCode } from '../../src/shared/startup-contract'

export interface StartupSender {
  id: number
  mainFrame: { url: string }
  isDestroyed(): boolean
}
export interface StartupEvent { sender: StartupSender; senderFrame?: StartupSender['mainFrame'] | null }
interface StartupControllerOptions {
  ipc: { handle(channel: string, listener: (event: StartupEvent, input?: unknown) => unknown): void }
  getTrustedSender(): StartupSender | null
  rendererUrl: string
  /** 全局数据迁移完成后的世代；还没就绪时为 null。 */
  getGlobalGeneration(): string | null
  getBlockedCode(): StartupBlockedCode | undefined
  getMigrationNotice?(): StartupMigrationNotice | undefined
}

/** Only the original renderer document in the main frame can acknowledge its own storage. */
export function isTrustedStartupSender(event: StartupEvent, sender: StartupSender | null, rendererUrl: string): boolean {
  if (!sender || sender.isDestroyed() || event?.sender !== sender || event.senderFrame !== sender.mainFrame) return false
  try {
    const actual = new URL(sender.mainFrame.url)
    const expected = new URL(rendererUrl)
    actual.hash = ''; expected.hash = ''
    return actual.href === expected.href
  } catch { return false }
}

export function registerStartupController(options: StartupControllerOptions): void {
  const acknowledgedRevisions = new Map<number, number>()
  const generation = () => {
    const value = options.getGlobalGeneration()
    return typeof value === 'string' && value.length > 0 ? value : null
  }
  const trusted = (event: StartupEvent) => isTrustedStartupSender(event, options.getTrustedSender(), options.rendererUrl)
  options.ipc.handle('startup:get-state', (event): StartupState => {
    if (!trusted(event)) return { state: 'blocked' }
    const code = options.getBlockedCode()
    if (code) return { state: 'blocked', code }
    const globalGeneration = generation()
    if (!globalGeneration) return { state: 'pending' }
    const notice = options.getMigrationNotice?.()
    const appearanceRevisionFloor = acknowledgedRevisions.get(event.sender.id)
    return { state: 'ready', globalGeneration,
      ...(appearanceRevisionFloor ? { appearanceRevisionFloor } : {}),
      ...(notice ? { migrationNotice: { legacySourceIgnored: notice.legacySourceIgnored, preservedUnknownCount: notice.preservedUnknownCount } } : {}) }
  })
  options.ipc.handle('startup:appearance-ack', (event, input) => {
    if (!trusted(event) || options.getBlockedCode() || !input || typeof input !== 'object' || Array.isArray(input)) return false
    const ack = input as Record<string, unknown>
    const keys = ['storageKey', 'profileRevision', 'globalGeneration']
    if (Object.keys(ack).length !== keys.length || !keys.every(key => Object.hasOwn(ack, key))) return false
    if (ack.storageKey !== APPEARANCE_STORAGE_KEY || !Number.isSafeInteger(ack.profileRevision)
      || (ack.profileRevision as number) < 1) return false
    const globalGeneration = generation()
    if (!globalGeneration || ack.globalGeneration !== globalGeneration) return false
    if ((ack.profileRevision as number) < (acknowledgedRevisions.get(event.sender.id) ?? 0)) return false
    acknowledgedRevisions.set(event.sender.id, ack.profileRevision as number)
    return true
  })
}
