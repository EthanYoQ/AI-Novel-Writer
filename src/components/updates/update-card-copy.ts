import type { UpdateError, UpdatePresentation, UpdateState } from '../../services/update-presentation'

export type UpdateText = (zhCNText: string, enUSText: string) => string

export function getUpdateErrorMessage(error: UpdateError | undefined, text: UpdateText): string {
  switch (error?.reason) {
    case 'configuration-missing':
      return text('测试/解压包缺少更新配置，请使用正式安装版或打开Release。', 'This test or unpacked build lacks update configuration. Install the formal package or open Releases.')
    case 'network':
      return text('无法连接更新服务。请检查网络连接后重试。', 'Could not reach the update service. Check your network connection and try again.')
    case 'proxy':
      return text('更新请求无法通过代理连接。请检查代理设置后重试。', 'The update request could not connect through the proxy. Check proxy settings and try again.')
    case 'tls':
      return text('无法验证更新服务的安全连接。请检查系统时间、证书或网络拦截。', 'Could not verify the secure update connection. Check system time, certificates, or network interception.')
    case 'http-forbidden':
      return text('没有权限访问更新发布信息。请打开Release手动下载正式安装包。', 'Access to update release information was denied. Open Releases to download the formal installer manually.')
    case 'http-not-found':
      return text('未找到更新发布信息。请打开Release手动下载正式安装包。', 'Update release information was not found. Open Releases to download the formal installer manually.')
    case 'http-rate-limited':
      return text('更新服务请求过于频繁。请稍后重试。', 'Too many update requests were made. Please try again later.')
    case 'metadata-invalid':
      return text('更新元数据无效。请打开Release手动下载正式安装包。', 'Update metadata is invalid. Open Releases to download the formal installer manually.')
    case 'asset-missing':
      return text('更新安装包不完整或缺失。请打开Release手动下载正式安装包。', 'The update installer is incomplete or missing. Open Releases to download the formal installer manually.')
  }

  switch (error?.code) {
    case 'UPDATES_DISABLED':
      return text('更新检查仅在已安装的 Windows 或 macOS 应用中可用。', 'Update checks are available in the installed Windows or macOS app only.')
    case 'DOWNLOAD_FAILED':
      return text('更新包暂时无法下载。请稍后重试。', 'The update could not be downloaded right now. Please try again later.')
    case 'DOWNLOAD_NOT_READY':
      return text('当前没有可下载的更新。请重新检查版本。', 'There is no update ready to download. Check for updates again.')
    case 'INSTALL_NOT_READY':
      return text('更新包尚未下载完成，暂时无法重启安装。', 'The update has not finished downloading, so it cannot be installed yet.')
    case 'INSTALL_FAILED':
      return text('无法启动更新安装。请稍后再试。', 'The update installer could not be started. Please try again later.')
    case 'OPEN_RELEASE_FAILED':
      return text('无法打开更新下载页。请稍后重试。', 'Could not open the update download page. Please try again later.')
    case 'REMINDER_NOT_AVAILABLE':
      return text('当前没有可延后的更新提醒。', 'There is no update reminder to postpone right now.')
    case 'REMINDER_SAVE_FAILED':
      return text('无法保存提醒时间，请检查配置目录后重试。', 'Could not save the reminder. Check the configuration folder and try again.')
    case 'INVALID_REMINDER_DELAY':
      return text('提醒时间无效，请重新选择。', 'That reminder period is unavailable. Please choose again.')
    case 'CHECK_FAILED':
    default:
      return text('更新操作暂时失败。请稍后重试。', 'The update operation failed temporarily. Please try again later.')
  }
}

export function getUpdateCardCopy(
  presentation: UpdatePresentation,
  state: UpdateState,
  text: UpdateText,
  manualActionError?: UpdateError,
) {
  const version = state.availableVersion ? `v${state.availableVersion}` : text('新版本', 'A new version')

  switch (presentation.kind) {
    case 'checking':
      return { title: text('正在检查更新', 'Checking for updates'), description: text('正在检查 GitHub Release 中的新正式版。', 'Checking GitHub Releases for a new stable version.') }
    case 'not-available':
      return { title: text('已是最新版本', 'You are up to date'), description: text('当前安装的版本已经是最新正式版。', 'The installed version is already the latest stable release.') }
    case 'available':
      return state.updateAction === 'open-release'
        ? { title: text('发现新版本', 'New version found'), description: text(`${version} 已可获取。打开下载页可获取适用于 macOS 的安装包。`, `${version} is available. Open the download page to get the macOS installer.`) }
        : { title: text('发现新版本', 'New version found'), description: text(`${version} 已可获取。点击“下载更新”后将在后台准备安装包。`, `${version} is available. Select “Download update” to prepare the installer in the background.`) }
    case 'downloading':
      return { title: text('正在下载更新', 'Downloading update'), description: text(`${version} 正在后台下载，您可以继续创作。`, `${version} is downloading in the background. You can keep writing.`) }
    case 'downloaded':
      return { title: text('更新已准备就绪', 'Update ready to install'), description: text(`${version} 已下载完成。重启后将开始安装。`, `${version} has finished downloading. Restart to begin installation.`) }
    case 'manual-error':
      return { title: text('无法完成更新操作', 'Could not complete update action'), description: getUpdateErrorMessage(manualActionError ?? state.error, text) }
    default:
      return { title: '', description: '' }
  }
}
