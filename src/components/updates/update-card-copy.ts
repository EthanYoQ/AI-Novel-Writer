import type { UpdateErrorCode, UpdatePresentation, UpdateState } from '../../services/update-presentation'

export type UpdateText = (zhCNText: string, enUSText: string) => string

export function getUpdateErrorMessage(code: UpdateErrorCode | undefined, text: UpdateText): string {
  switch (code) {
    case 'UPDATES_DISABLED':
      return text('更新检查仅在已安装的 Windows 应用中可用。', 'Update checks are available in the installed Windows app only.')
    case 'DOWNLOAD_FAILED':
      return text('更新包暂时无法下载。请稍后重试。', 'The update could not be downloaded right now. Please try again later.')
    case 'INSTALL_NOT_READY':
      return text('更新包尚未下载完成，暂时无法重启安装。', 'The update has not finished downloading, so it cannot be installed yet.')
    case 'INSTALL_FAILED':
      return text('无法启动更新安装。请稍后再试。', 'The update installer could not be started. Please try again later.')
    case 'REMINDER_NOT_AVAILABLE':
      return text('当前没有可延后的更新提醒。', 'There is no update reminder to postpone right now.')
    case 'INVALID_REMINDER_DELAY':
      return text('提醒时间无效，请重新选择。', 'That reminder period is unavailable. Please choose again.')
    case 'CHECK_FAILED':
    default:
      return text('暂时无法连接更新服务。请检查网络后重试。', 'The update service is temporarily unavailable. Check your connection and try again.')
  }
}

export function getUpdateCardCopy(
  presentation: UpdatePresentation,
  state: UpdateState,
  text: UpdateText,
  manualActionError?: UpdateErrorCode,
) {
  const version = state.availableVersion ? `v${state.availableVersion}` : text('新版本', 'A new version')

  switch (presentation.kind) {
    case 'checking':
      return { title: text('正在检查更新', 'Checking for updates'), description: text('正在检查 GitHub Release 中的新正式版。', 'Checking GitHub Releases for a new stable version.') }
    case 'not-available':
      return { title: text('已是最新版本', 'You are up to date'), description: text('当前安装的版本已经是最新正式版。', 'The installed version is already the latest stable release.') }
    case 'available':
      return { title: text('发现新版本', 'New version found'), description: text(`${version} 已可获取。点击“继续准备更新”后，应用会检查并在后台准备安装包。`, `${version} is available. Select “Continue preparing update” to check and prepare the installer in the background.`) }
    case 'downloading':
      return { title: text('正在下载更新', 'Downloading update'), description: text(`${version} 正在后台下载，您可以继续创作。`, `${version} is downloading in the background. You can keep writing.`) }
    case 'downloaded':
      return { title: text('更新已准备就绪', 'Update ready to install'), description: text(`${version} 已下载完成。重启后将开始安装。`, `${version} has finished downloading. Restart to begin installation.`) }
    case 'manual-error':
      return { title: text('无法完成更新操作', 'Could not complete update action'), description: getUpdateErrorMessage(manualActionError ?? state.error?.code, text) }
    default:
      return { title: '', description: '' }
  }
}
