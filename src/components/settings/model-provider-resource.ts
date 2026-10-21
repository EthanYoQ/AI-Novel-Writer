import { displayedErrorMessage } from '../../i18n/app-errors'
import { useLocaleStore } from '../../stores/locale-store'
import type { ModelProviderResourceId } from '../../shared/model-provider-resources'
import { ipc } from '../../services/ipc-client'
import { alertError } from '../ui/AlertDialog'

type LocalizedText = (zhCNText: string, enUSText: string) => string

/** Open only an allowlisted provider resource through the trusted main-process IPC boundary. */
export async function openModelProviderResource(resource: ModelProviderResourceId, text: LocalizedText) {
  try {
    const result = await ipc.invoke('model-provider-resource:open', resource)
    if (!result.success) throw new Error(result.error || text('无法打开服务商页面', 'Unable to open provider page'))
  } catch (error) {
    alertError(displayedErrorMessage(useLocaleStore.getState().locale, error), { title: text('打开链接失败', 'Unable to open link') })
  }
}
