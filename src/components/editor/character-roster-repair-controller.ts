import type { ProjectSessionContext } from '../../shared/ipc-channels'
import type { CharacterRosterSnapshot } from '../../shared/character-roster'
import { LatestRequestGate } from './latest-request-gate'

export interface CharacterRosterRepairState {
  snapshot: CharacterRosterSnapshot | null
  repairError: string | null
  isRepairing: boolean
}

/**
 * Renderer-specific port for the structured roster read / explicit legacy
 * migration seam. The controller owns request ordering; the hook supplies
 * React state and the live project-session guard.
 */
export interface CharacterRosterRepairPort {
  getSession(): ProjectSessionContext | null
  isSessionUsable(session: ProjectSessionContext): boolean
  read(session: ProjectSessionContext): Promise<CharacterRosterSnapshot>
  migrate(projectPath: string): Promise<void>
  setState(next: Partial<CharacterRosterRepairState>): void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Keeps the roster's read, explicit migration and error state internally
 * consistent across project-session switches. It has no React dependency so
 * the session race boundary remains directly testable.
 */
export class CharacterRosterRepairController {
  private readonly readGate = new LatestRequestGate()
  private repairEpoch = 0
  private repairInFlight = false

  constructor(private readonly getPort: () => CharacterRosterRepairPort) {}

  /** Invalidate every in-flight operation without mutating an unmounted view. */
  invalidate(): void {
    this.readGate.begin()
    this.repairEpoch += 1
    this.repairInFlight = false
  }

  async load(): Promise<CharacterRosterSnapshot | null> {
    const port = this.getPort()
    const session = port.getSession()
    if (!session || !port.isSessionUsable(session)) {
      port.setState({ snapshot: null, repairError: null, isRepairing: false })
      return null
    }

    const requestId = this.readGate.begin()
    let snapshot: CharacterRosterSnapshot
    try {
      snapshot = await port.read(session)
    } catch {
      if (this.canApplyRead(requestId, session)) {
        this.getPort().setState({ snapshot: null })
      }
      return null
    }

    if (!this.canApplyRead(requestId, session)) return null
    const currentPort = this.getPort()
    currentPort.setState({ snapshot })
    if (snapshot.status === 'ready') currentPort.setState({ repairError: null })
    return snapshot
  }

  async migrate(): Promise<void> {
    if (this.repairInFlight) return

    const port = this.getPort()
    const session = port.getSession()
    if (!session || !port.isSessionUsable(session)) return

    const repairToken = ++this.repairEpoch
    this.repairInFlight = true
    port.setState({ isRepairing: true, repairError: null })
    try {
      await port.migrate(session.projectPath)
      if (!this.canApplyRepair(repairToken, session)) return
      await this.load()
    } catch (error) {
      if (this.canApplyRepair(repairToken, session)) {
        this.getPort().setState({ repairError: errorMessage(error) })
      }
    } finally {
      if (this.repairEpoch === repairToken) {
        this.repairInFlight = false
        if (this.getPort().isSessionUsable(session)) {
          this.getPort().setState({ isRepairing: false })
        }
      }
    }
  }

  private canApplyRead(requestId: number, session: ProjectSessionContext): boolean {
    return this.readGate.isLatest(requestId) && this.getPort().isSessionUsable(session)
  }

  private canApplyRepair(repairToken: number, session: ProjectSessionContext): boolean {
    return this.repairEpoch === repairToken && this.getPort().isSessionUsable(session)
  }
}
