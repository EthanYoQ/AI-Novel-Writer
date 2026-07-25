import { useCallback, useEffect, useMemo, useState } from 'react'

import { ipc } from '../../services/ipc-client'
import {
  getUpdatePresentation,
  type UpdateErrorCode,
  type UpdateState,
} from '../../services/update-presentation'

const disabledState: UpdateState = {
  status: 'disabled',
  currentVersion: '',
  isReminderDeferred: false,
}

/** 将 IPC 订阅和更新操作集中在一个可替换的状态边界内。 */
export function useUpdateState() {
  const [state, setState] = useState<UpdateState>(disabledState)
  const [manualCheckRequested, setManualCheckRequested] = useState(false)
  const [manualActionError, setManualActionError] = useState<UpdateErrorCode>()
  const [isDeferring, setIsDeferring] = useState(false)

  useEffect(() => {
    if (!ipc.isElectron) return undefined

    let mounted = true
    const applyState = (nextState: UpdateState) => {
      if (mounted) setState(nextState)
    }
    const unsubscribe = ipc.on('update:state', applyState)
    void ipc.invoke('update:get-state').then(applyState).catch(() => applyState(disabledState))

    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  const presentation = useMemo(
    () => getUpdatePresentation({ state, manualCheckRequested, manualActionError }),
    [manualActionError, manualCheckRequested, state],
  )

  const checkForUpdates = useCallback(async () => {
    if (!presentation.canCheck || !ipc.isElectron) return
    setManualCheckRequested(true)
    setManualActionError(undefined)
    try {
      const response = await ipc.invoke('update:check')
      setState(response.state)
      setManualActionError(response.error?.code)
    } catch {
      setManualActionError('CHECK_FAILED')
    }
  }, [presentation.canCheck])

  const deferReminder = useCallback(async (days: 7 | 30) => {
    if (!presentation.canDefer || !ipc.isElectron) return
    setIsDeferring(true)
    setManualActionError(undefined)
    try {
      const response = await ipc.invoke('update:defer-reminder', days)
      setState(response.state)
      setManualActionError(response.error?.code)
      if (response.success) setManualCheckRequested(false)
    } catch {
      setManualActionError('REMINDER_NOT_AVAILABLE')
    } finally {
      setIsDeferring(false)
    }
  }, [presentation.canDefer])

  const requestInstall = useCallback(async () => {
    if (!presentation.canInstall || !ipc.isElectron) return
    setManualActionError(undefined)
    try {
      const response = await ipc.invoke('update:quit-and-install')
      setState(response.state)
      setManualActionError(response.error?.code)
    } catch {
      setManualActionError('INSTALL_FAILED')
    }
  }, [presentation.canInstall])

  return { state, presentation, manualActionError, isDeferring, checkForUpdates, deferReminder, requestInstall }
}
