import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * 安装包产品名（electron-builder productName），决定 exe、.app 与卸载程序的文件名。
 * 1.3.0 及以前叫 AI小说作家；升级测试会启动旧版本，所以凡是可能碰到旧版本的地方要两个都认（ADR-0022）。
 * PowerShell 脚本里有同样的名单，改这里时一并改。
 */
export const PRODUCT_NAME = '书童'
export const LEGACY_PRODUCT_NAME = 'AI小说作家'
export const PRODUCT_NAMES = [PRODUCT_NAME, LEGACY_PRODUCT_NAME]

export const WINDOWS_EXECUTABLE_NAME = `${PRODUCT_NAME}.exe`
export const WINDOWS_EXECUTABLE_NAMES = PRODUCT_NAMES.map(name => `${name}.exe`)

/** 进程监控按名字认领的目标：exe 名、去掉扩展名的名字，加上 package.json 的 name。 */
export const WINDOWS_PROCESS_TARGET_NAMES = [
  ...PRODUCT_NAMES.flatMap(name => [`${name}.exe`, name]),
  'ai-novel-writer',
]

/** 在解包目录或安装目录里找 exe：新名优先，找不到再找旧名；都没有时返回新名路径，由调用方报缺失。 */
export function resolveWindowsExecutable(directory) {
  const candidates = WINDOWS_EXECUTABLE_NAMES.map(name => path.join(directory, name))
  return candidates.find(candidate => existsSync(candidate)) ?? candidates[0]
}

/** macOS：.app 包内 Contents/MacOS 下的可执行文件，规则同上。 */
export function resolveMacExecutable(appBundle) {
  const candidates = PRODUCT_NAMES.map(name => path.join(appBundle, 'Contents', 'MacOS', name))
  return candidates.find(candidate => existsSync(candidate)) ?? candidates[0]
}
