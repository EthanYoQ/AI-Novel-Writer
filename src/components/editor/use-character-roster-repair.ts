import { useCallback, useEffect, useMemo, useState } from 'react'

import { useProjectStore } from '../../stores/project-store'
import { ipc } from '../../services/ipc-client'
import { migrateLegacyCharacterRoster } from '../../services/workflows/architecture-workflow'
import {
  captureProjectSession,
  isProjectSessionCurrent,
  isProjectSessionPath,
} from '../project-session-gate'
import {
  CharacterRosterRepairController,
  type CharacterRosterRepairPort,
  type CharacterRosterRepairState,
} from './character-roster-repair-controller'

const EMPTY_STATE: CharacterRosterRepairState = {
  snapshot: null,
  repairError: null,
  isRepairing: false,
}

interface SessionBoundRosterRepairState extends CharacterRosterRepairState {
  sessionKey: string
}

export interface UseCharacterRosterRepairOptions {
  projectKey: string
  enabled?: boolean
}

function projectSessionKey(
  projectId: string | undefined,
  projectPath: string | undefined,
  projectLease: string | undefined,
): string {
  return projectId && projectPath && projectLease
    ? `${projectId}\u0000${projectLease}\u0000${projectPath}`
    : ''
}

/**
 * Shared renderer hook for the read-only roster status and the author's
 * explicit legacy migration action. The controller guards complete project
 * session identity; it never writes while merely loading a view.
 */
export function useCharacterRosterRepair({
  projectKey,
  enabled = true,
}: UseCharacterRosterRepairOptions) {
  // Subscribe only to identity fields so a config-field update does not
  // recreate a roster request or invalidate a valid editor draft.
  const projectId = useProjectStore(state => state.currentProject?.id)
  const projectPath = useProjectStore(state => state.currentProject?.path)
  const projectLease = useProjectStore(state => state.currentProject?.sessionLease)
  const sessionKey = projectSessionKey(projectId, projectPath, projectLease)
  const [state, setState] = useState<SessionBoundRosterRepairState>({
    ...EMPTY_STATE,
    sessionKey: '',
  })

  const setControllerState = useCallback((next: Partial<CharacterRosterRepairState>) => {
    setState(previous => ({ ...previous, ...next, sessionKey }))
  }, [sessionKey])

  const port = useMemo<CharacterRosterRepairPort>(() => ({
    getSession: () => captureProjectSession(useProjectStore.getState().currentProject),
    isSessionUsable: session => (
      enabled
      && projectSessionKey(session.projectId, session.projectPath, session.leaseId) === sessionKey
      && isProjectSessionPath(session, projectKey)
      && isProjectSessionCurrent(session)
    ),
    read: session => ipc.invokeWithProjectSession(
      session,
      'db:character-roster-read',
      session.projectPath,
    ),
    migrate: projectPath => migrateLegacyCharacterRoster(projectPath),
    setState: setControllerState,
  }), [enabled, projectKey, sessionKey, setControllerState])

  const controller = useMemo(
    () => new CharacterRosterRepairController(() => port),
    [port],
  )
  const refresh = useCallback(() => controller.load(), [controller])
  const migrate = useCallback(() => controller.migrate(), [controller])

  useEffect(() => {
    const timer = setTimeout(() => { void controller.load() }, 0)
    return () => {
      clearTimeout(timer)
      controller.invalidate()
    }
  }, [controller])

  // The previous session's state is never rendered during a switch, even in
  // the small interval before the next read resolves. The old controller is
  // invalidated by the effect cleanup above.
  const visibleState = state.sessionKey === sessionKey ? state : EMPTY_STATE
  return {
    snapshot: visibleState.snapshot,
    repairError: visibleState.repairError,
    isRepairing: visibleState.isRepairing,
    refresh,
    migrate,
  }
}
