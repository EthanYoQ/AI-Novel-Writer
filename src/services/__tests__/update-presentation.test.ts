import { describe, expect, it } from 'vitest'

import { getUpdatePresentation, type UpdateError } from '../update-presentation'

const baseState = {
  currentVersion: '0.2.5',
  isReminderDeferred: false,
} as const

const checkFailure = {
  code: 'CHECK_FAILED',
  phase: 'check',
  reason: 'unknown',
  retryable: true,
  safeTechnicalDetails: 'UPDATE_OPERATION_FAILED',
} satisfies UpdateError

const installFailure = {
  code: 'INSTALL_FAILED',
  phase: 'install',
  reason: 'install-failed',
  retryable: true,
  safeTechnicalDetails: 'INSTALL_FAILED',
} satisfies UpdateError

describe('getUpdatePresentation', () => {
  it('keeps the update button disabled while an automatic check is running', () => {
    expect(getUpdatePresentation({
      state: { ...baseState, status: 'checking' },
      manualCheckRequested: false,
    })).toMatchObject({
      kind: 'hidden',
      visible: false,
      canCheck: false,
    })
  })

  it('keeps automatic checks silent when no update is available or a background failure is reported', () => {
    expect(getUpdatePresentation({
      state: { ...baseState, status: 'not-available' },
      manualCheckRequested: false,
    })).toMatchObject({
      kind: 'hidden',
      visible: false,
      canCheck: true,
    })

    expect(getUpdatePresentation({
      state: { ...baseState, status: 'error', error: checkFailure },
      manualCheckRequested: false,
    })).toMatchObject({
      kind: 'hidden',
      visible: false,
      canCheck: true,
    })
  })

  it('shows an understandable result for a manual check', () => {
    expect(getUpdatePresentation({
      state: { ...baseState, status: 'checking' },
      manualCheckRequested: true,
    })).toMatchObject({ kind: 'checking', visible: true, canCheck: false })

    expect(getUpdatePresentation({
      state: { ...baseState, status: 'not-available' },
      manualCheckRequested: true,
    })).toMatchObject({ kind: 'not-available', visible: true, canCheck: true })

    expect(getUpdatePresentation({
      state: { ...baseState, status: 'error', error: checkFailure },
      manualCheckRequested: true,
    })).toMatchObject({ kind: 'manual-error', visible: true, canCheck: true })
  })

  it('exposes progress during download and restart only after the installer is ready', () => {
    expect(getUpdatePresentation({
      state: {
        ...baseState,
        status: 'downloading',
        availableVersion: '0.2.6',
        downloadProgress: { percent: 42, transferred: 42, total: 100, bytesPerSecond: 10 },
      },
      manualCheckRequested: false,
    })).toMatchObject({
      kind: 'downloading',
      visible: true,
      showProgress: true,
      canInstall: false,
      canDefer: true,
    })

    expect(getUpdatePresentation({
      state: { ...baseState, status: 'downloaded', availableVersion: '0.2.6' },
      manualCheckRequested: false,
    })).toMatchObject({
      kind: 'downloaded',
      visible: true,
      canInstall: true,
      canDefer: true,
    })
  })

  it('hides a deferred update without disabling manual checking', () => {
    expect(getUpdatePresentation({
      state: {
        ...baseState,
        status: 'downloaded',
        availableVersion: '0.2.6',
        isReminderDeferred: true,
        reminderUntil: '2026-08-01T00:00:00.000Z',
      },
      manualCheckRequested: false,
    })).toMatchObject({
      kind: 'hidden',
      visible: false,
      canCheck: true,
    })
  })

  it('shows a deferred release again when the user explicitly checks for updates', () => {
    expect(getUpdatePresentation({
      state: {
        ...baseState,
        status: 'downloaded',
        availableVersion: '0.2.6',
        isReminderDeferred: true,
        reminderUntil: '2026-08-01T00:00:00.000Z',
      },
      manualCheckRequested: true,
    })).toMatchObject({
      kind: 'downloaded',
      visible: true,
      canInstall: true,
    })
  })

  it('hides the card again after a successful defer resets the one-time manual result', () => {
    const state = {
      ...baseState,
      status: 'downloaded' as const,
      availableVersion: '0.2.6',
      isReminderDeferred: true,
      reminderUntil: '2026-08-01T00:00:00.000Z',
    }

    expect(getUpdatePresentation({ state, manualCheckRequested: true })).toMatchObject({
      kind: 'downloaded',
      visible: true,
    })
    expect(getUpdatePresentation({ state, manualCheckRequested: false })).toMatchObject({
      kind: 'hidden',
      visible: false,
    })
  })

  it('does not expose real update actions outside a packaged Electron app', () => {
    expect(getUpdatePresentation({
      state: { ...baseState, status: 'disabled' },
      manualCheckRequested: false,
    })).toMatchObject({
      kind: 'disabled',
      visible: false,
      canCheck: false,
      canDefer: false,
      canInstall: false,
    })
  })

  it('keeps a downloaded installer recoverable when a manual restart request fails', () => {
    expect(getUpdatePresentation({
      state: { ...baseState, status: 'downloaded', availableVersion: '0.2.6' },
      manualCheckRequested: true,
      manualActionError: installFailure,
    })).toMatchObject({
      kind: 'manual-error',
      visible: true,
      canInstall: true,
      canDefer: true,
    })
  })
})
