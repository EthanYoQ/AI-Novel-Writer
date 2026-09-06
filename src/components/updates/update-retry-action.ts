import type { UpdateErrorCode } from '../../services/update-presentation'

export type UpdateRetryAction = 'check' | 'download' | 'open-release' | 'install' | 'defer'

export function getUpdateRetryAction(errorCode?: UpdateErrorCode): UpdateRetryAction {
  if (errorCode === 'INSTALL_FAILED') return 'install'
  if (errorCode === 'DOWNLOAD_FAILED' || errorCode === 'DOWNLOAD_NOT_READY') return 'download'
  if (errorCode === 'OPEN_RELEASE_FAILED') return 'open-release'
  if (errorCode === 'REMINDER_SAVE_FAILED') return 'defer'
  return 'check'
}
