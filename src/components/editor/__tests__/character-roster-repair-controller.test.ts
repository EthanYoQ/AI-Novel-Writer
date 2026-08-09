import { describe, expect, it, vi } from 'vitest'

import {
  CharacterRosterRepairController,
  type CharacterRosterRepairPort,
  type CharacterRosterRepairState,
} from '../character-roster-repair-controller'
import type { CharacterRosterSnapshot } from '../../../shared/character-roster'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'

const sessionA: ProjectSessionContext = {
  projectId: 'project-a',
  leaseId: 'lease-a',
  projectPath: 'C:/novels/A',
}

const sessionB: ProjectSessionContext = {
  projectId: 'project-b',
  leaseId: 'lease-b',
  projectPath: 'C:/novels/B',
}

const pendingSnapshot: CharacterRosterSnapshot = {
  schemaVersion: 1,
  revision: 0,
  migrationState: 'legacy_markdown_pending',
  status: 'legacy_repair_required',
  entries: [],
  renderedMarkdown: '',
  projectionHash: 'pending',
  factHash: 'pending-fact',
  legacyMarkdown: '旧角色图谱原文',
}

const readySnapshot: CharacterRosterSnapshot = {
  schemaVersion: 1,
  revision: 1,
  migrationState: 'ready',
  status: 'ready',
  entries: [],
  renderedMarkdown: '',
  projectionHash: 'ready',
  factHash: 'ready-fact',
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve })
  return { promise, resolve }
}

function createHarness(options: {
  read: CharacterRosterRepairPort['read']
  migrate?: CharacterRosterRepairPort['migrate']
}) {
  let activeSession: ProjectSessionContext | null = sessionA
  const state: CharacterRosterRepairState = {
    snapshot: null,
    repairError: null,
    isRepairing: false,
  }
  const setState = vi.fn((next: Partial<CharacterRosterRepairState>) => {
    Object.assign(state, next)
  })
  const port: CharacterRosterRepairPort = {
    getSession: () => activeSession,
    isSessionUsable: session => (
      activeSession?.projectId === session.projectId
      && activeSession.leaseId === session.leaseId
      && activeSession.projectPath === session.projectPath
    ),
    read: options.read,
    migrate: options.migrate ?? vi.fn().mockResolvedValue(undefined),
    setState,
  }
  return {
    controller: new CharacterRosterRepairController(() => port),
    state,
    setActiveSession: (next: ProjectSessionContext | null) => { activeSession = next },
    migrate: port.migrate,
    setState,
  }
}

describe('CharacterRosterRepairController public seam', () => {
  it('keeps a late roster read from session A from overwriting the current session B state', async () => {
    const lateA = deferred<CharacterRosterSnapshot>()
    const read = vi.fn()
      .mockImplementationOnce(() => lateA.promise)
      .mockResolvedValueOnce(readySnapshot)
    const harness = createHarness({ read })

    const loadingA = harness.controller.load()
    harness.setActiveSession(sessionB)
    harness.controller.invalidate()
    await harness.controller.load()
    lateA.resolve(pendingSnapshot)
    await loadingA

    expect(harness.state.snapshot).toEqual(readySnapshot)
    expect(harness.state.repairError).toBeNull()
  })

  it('runs one explicit legacy roster migration, clears a prior repair error, and refreshes the authoritative roster', async () => {
    const migrate = vi.fn().mockResolvedValue(undefined)
    const read = vi.fn().mockResolvedValue(readySnapshot)
    const harness = createHarness({ read, migrate })
    harness.state.repairError = '上一轮失败'

    await harness.controller.migrate()

    expect(migrate).toHaveBeenCalledExactlyOnceWith(sessionA.projectPath)
    expect(read).toHaveBeenCalledExactlyOnceWith(sessionA)
    expect(harness.state).toEqual({
      snapshot: readySnapshot,
      repairError: null,
      isRepairing: false,
    })
  })

  it('records a migration error only while the same project session remains current', async () => {
    const migrate = vi.fn().mockRejectedValue(new Error('模型不可用'))
    const harness = createHarness({ read: vi.fn(), migrate })

    await harness.controller.migrate()

    expect(harness.state).toEqual({
      snapshot: null,
      repairError: '模型不可用',
      isRepairing: false,
    })
  })
})
