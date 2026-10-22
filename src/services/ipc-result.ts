import { knownAppErrorMessage } from '../i18n/app-errors'
import { useLocaleStore } from '../stores/locale-store'

export interface IpcMutationResult {
  success: boolean
  error?: string
}

/**
 * IPC mutations report business failures as values rather than rejected
 * promises. Convert them to exceptions so workflows cannot continue after a
 * persistence operation failed.
 *
 * 主进程登记过的码按界面语言说明；主进程没给原因时，用调用方的 fallbackMessage，
 * 没有就用「<action>失败」。action 多是只有中文的动作名，英文界面改用通用说明。
 */
export function requireIpcSuccess<T extends IpcMutationResult>(
  result: T,
  action: string,
  fallbackMessage?: string,
): T {
  if (!result.success) {
    const { locale, text } = useLocaleStore.getState()
    throw new Error(knownAppErrorMessage(locale, result.error)
      ?? (result.error || fallbackMessage || text(`${action}失败`, 'The operation failed.')))
  }
  return result
}
