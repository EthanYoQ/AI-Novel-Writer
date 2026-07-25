import type { UpdateErrorCode } from '../../services/update-presentation'

export type UpdateRetryAction = 'check' | 'install' | 'defer'

export function getUpdateRetryAction(errorCode?: UpdateErrorCode): UpdateRetryAction {
  if (errorCode === 'INSTALL_FAILED') return 'install'
  if (errorCode === 'REMINDER_SAVE_FAILED') return 'defer'
  return 'check'
}
