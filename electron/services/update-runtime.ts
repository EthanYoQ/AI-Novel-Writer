import { existsSync } from 'node:fs'
import path from 'node:path'

/** 只有已安装的 Windows 应用才允许触达 GitHub Release 更新器。 */
export function isWindowsUpdateRuntimeEnabled(
  isPackaged: boolean,
  devServerUrl: string | undefined,
  platform = process.platform,
): boolean {
  return platform === 'win32' && isPackaged && !devServerUrl
}

/**
 * Electron Builder 将发布更新源写入 resources/app-update.yml。解压测试包没有
 * 这个文件时，不能把本地配置缺失误导为网络故障，更不能启动更新器探测。
 */
export function hasWindowsUpdateConfiguration(
  resourcesPath: string | undefined = process.resourcesPath,
  existsAt: (filePath: string) => boolean = existsSync,
): boolean {
  return typeof resourcesPath === 'string'
    && existsAt(path.join(resourcesPath, 'app-update.yml'))
}
