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

const MAX_TIMER_DELAY_MS = 2_147_000_000

/**
 * setTimeout 在约 24.8 天后会溢出；30 天提醒必须拆成多段，并在每段
 * 到期后依据当前时钟重新计算。返回值用于版本切换和组件卸载时取消。
 */
export function scheduleReminderRefresh(
  reminderUntil: string,
  refresh: () => void | Promise<void>,
  now: () => number = Date.now,
): () => void {
  const deadline = Date.parse(reminderUntil)
  if (!Number.isFinite(deadline)) return () => {}

  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = () => {
    if (cancelled) return
    const remaining = deadline - now()
    const delay = Math.max(0, Math.min(remaining, MAX_TIMER_DELAY_MS))
    timer = setTimeout(() => {
      if (cancelled) return
      if (deadline > now()) {
        arm()
        return
      }
      void refresh()
    }, delay)
  }
  arm()

  return () => {
    cancelled = true
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** 将 IPC 订阅和更新操作集中在一个可替换的状态边界内。 */
export function useUpdateState() {
  const [state, setState] = useState<UpdateState>(disabledState)
  const [manualCheckRequested, setManualCheckRequested] = useState(false)
  const [manualActionError, setManualActionError] = useState<UpdateErrorCode>()
  const [isDeferring, setIsDeferring] = useState(false)
  const [lastReminderDays, setLastReminderDays] = useState<7 | 30>(7)

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

  useEffect(() => {
    if (
      !ipc.isElectron
      || !state.availableVersion
      || !state.reminderUntil
      || !state.isReminderDeferred
    ) return undefined

    let active = true
    const cancel = scheduleReminderRefresh(state.reminderUntil, async () => {
      try {
        const refreshed = await ipc.invoke('update:get-state')
        if (active) setState(refreshed)
      } catch {
        // 下一次主进程状态事件或手动检查仍可恢复；不制造误导性错误卡。
      }
    })
    return () => {
      active = false
      cancel()
    }
  }, [state.availableVersion, state.isReminderDeferred, state.reminderUntil])

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
    setLastReminderDays(days)
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

  return {
    state,
    presentation,
    manualActionError,
    isDeferring,
    lastReminderDays,
    checkForUpdates,
    deferReminder,
    requestInstall,
  }
}
