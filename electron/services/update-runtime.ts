/** 只有已安装的 Windows 应用才允许触达 GitHub Release 更新器。 */
export function isWindowsUpdateRuntimeEnabled(
  isPackaged: boolean,
  devServerUrl: string | undefined,
  platform = process.platform,
): boolean {
  return platform === 'win32' && isPackaged && !devServerUrl
}
