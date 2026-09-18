import { APPEARANCE_STORAGE_KEY } from '../../src/shared/appearance-profile'
import type { AppearanceSkinSnapshot, StartupState, StartupMigrationNotice, StartupBlockedCode } from '../../src/shared/startup-contract'

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
  getSnapshot(): AppearanceSkinSnapshot | null
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

function validSnapshot(value: AppearanceSkinSnapshot | null): value is AppearanceSkinSnapshot {
  return value !== null && typeof value.globalGeneration === 'string' && value.globalGeneration.length > 0
    && Number.isSafeInteger(value.skinRevision) && value.skinRevision >= 0
    && ['classic', 'anime', 'custom'].includes(value.backgroundSkin)
}

export function registerStartupController(options: StartupControllerOptions): void {
  const acknowledgedRevisions = new Map<number, number>()
  const snapshot = () => {
    const value = options.getSnapshot()
    if (!validSnapshot(value)) throw new Error('全局配置或皮肤尚未就绪，已保留现有设置')
    return { ...value }
  }
  const trusted = (event: StartupEvent) => isTrustedStartupSender(event, options.getTrustedSender(), options.rendererUrl)
  options.ipc.handle('startup:get-state', (event): StartupState => {
    if (!trusted(event)) return { state: 'blocked' }
    const code = options.getBlockedCode()
    if (code) return { state: 'blocked', code }
    try {
      const current = snapshot()
      const notice = options.getMigrationNotice?.()
      return { state: 'ready', globalGeneration: current.globalGeneration, skinRevision: current.skinRevision,
        ...(notice ? { migrationNotice: { legacySourceIgnored: notice.legacySourceIgnored, preservedUnknownCount: notice.preservedUnknownCount } } : {}) }
    } catch { return { state: 'pending' } }
  })
  options.ipc.handle('startup:skin-snapshot', (event, input) => {
    if (!trusted(event) || options.getBlockedCode()) throw new Error('启动快照访问被拒绝')
    const current = snapshot()
    const expected = input as Record<string, unknown> | null
    if (!expected || expected.state !== 'ready' || expected.globalGeneration !== current.globalGeneration
      || expected.skinRevision !== current.skinRevision) throw new Error('启动快照已变化，请重新检查')
    return current
  })
  options.ipc.handle('startup:appearance-ack', (event, input) => {
    if (!trusted(event) || options.getBlockedCode() || !input || typeof input !== 'object' || Array.isArray(input)) return false
    const ack = input as Record<string, unknown>
    const keys = ['storageKey', 'profileRevision', 'globalGeneration', 'skinRevision']
    if (Object.keys(ack).length !== keys.length || !keys.every(key => Object.hasOwn(ack, key))) return false
    if (ack.storageKey !== APPEARANCE_STORAGE_KEY || !Number.isSafeInteger(ack.profileRevision)
      || (ack.profileRevision as number) < 1) return false
    try {
      const current = snapshot()
      if (ack.globalGeneration !== current.globalGeneration || ack.skinRevision !== current.skinRevision) return false
      if ((ack.profileRevision as number) < (acknowledgedRevisions.get(event.sender.id) ?? 0)) return false
      acknowledgedRevisions.set(event.sender.id, ack.profileRevision as number)
      return true
    } catch { return false }
  })
}
