import type { UpdateChannels } from '../shared/ipc-channels'

export type UpdateState = UpdateChannels['update:get-state']['return']
export type UpdateErrorCode = NonNullable<UpdateState['error']>['code']

export type UpdatePresentationKind =
  | 'hidden'
  | 'disabled'
  | 'checking'
  | 'not-available'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'manual-error'

export interface UpdatePresentation {
  kind: UpdatePresentationKind
  visible: boolean
  canCheck: boolean
  canDefer: boolean
  canInstall: boolean
  showProgress: boolean
}

export interface UpdatePresentationInput {
  state?: UpdateState | null
  manualCheckRequested: boolean
  manualActionError?: UpdateErrorCode
}

const hiddenPresentation: UpdatePresentation = {
  kind: 'hidden',
  visible: false,
  canCheck: true,
  canDefer: false,
  canInstall: false,
  showProgress: false,
}

function visiblePresentation(
  kind: Exclude<UpdatePresentationKind, 'hidden' | 'disabled'>,
  controls: Partial<Pick<UpdatePresentation, 'canCheck' | 'canDefer' | 'canInstall' | 'showProgress'>> = {},
): UpdatePresentation {
  return {
    ...hiddenPresentation,
    kind,
    visible: true,
    ...controls,
  }
}

/**
 * 将更新服务的状态转换成欢迎页可观察的展示状态。
 * 自动检查始终保持静默；只有用户主动检查时才展示“无更新”或错误反馈。
 */
export function getUpdatePresentation(input: UpdatePresentationInput): UpdatePresentation {
  const { state } = input

  if (!state || state.status === 'disabled') {
    return {
      ...hiddenPresentation,
      kind: 'disabled',
      canCheck: false,
    }
  }

  if (state.status === 'checking') {
    return input.manualCheckRequested
      ? visiblePresentation('checking', { canCheck: false })
      : { ...hiddenPresentation, canCheck: false }
  }

  if (input.manualActionError || (input.manualCheckRequested && state.status === 'error')) {
    return visiblePresentation('manual-error', {
      canDefer: Boolean(state.availableVersion) && !state.isReminderDeferred,
      canInstall: state.status === 'downloaded',
    })
  }

  if (input.manualCheckRequested && state.status === 'not-available') {
    return visiblePresentation('not-available')
  }

  if (state.isReminderDeferred && state.availableVersion && !input.manualCheckRequested) {
    return hiddenPresentation
  }

  const canDefer = Boolean(state.availableVersion)
  if (state.status === 'available') {
    return visiblePresentation('available', { canDefer })
  }

  if (state.status === 'downloading') {
    return visiblePresentation('downloading', {
      canCheck: false,
      canDefer,
      showProgress: true,
    })
  }

  if (state.status === 'downloaded') {
    return visiblePresentation('downloaded', {
      canCheck: false,
      canDefer,
      canInstall: true,
    })
  }

  return hiddenPresentation
}
