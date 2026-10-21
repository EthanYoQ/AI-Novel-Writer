import { useEffect, useState } from 'react'
import { ipc } from '../../services/ipc-client'
import { useLocaleStore } from '../../stores/locale-store'
import { displayedErrorMessage } from '../../i18n/app-errors'

export interface ProxyDraft {
  enabled: boolean
  type: 'http' | 'socks5'
  host: string
  /** 输入框清空时为空串，失焦时回退到 7890。 */
  port: number | ''
}

const DEFAULT_PROXY: ProxyDraft = { enabled: false, type: 'http', host: '', port: 7890 }

/** 网络代理的读取与保存。 */
export function useProxySettings() {
  const text = useLocaleStore(s => s.text)
  const [proxy, setProxy] = useState<ProxyDraft>(DEFAULT_PROXY)
  const [stored, setStored] = useState<ProxyDraft>(DEFAULT_PROXY)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    ipc.invoke('config:get').then((cfg) => {
      if (cfg?.proxy) {
        const loaded: ProxyDraft = {
          enabled: cfg.proxy.enabled ?? false,
          type: cfg.proxy.type ?? 'http',
          host: cfg.proxy.host ?? '',
          port: cfg.proxy.port ?? 7890,
        }
        setProxy(loaded)
        setStored(loaded)
      }
    }).catch(() => { })
  }, [])

  const save = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      const result = await ipc.invoke('config:set', { proxy: { ...proxy, port: Number(proxy.port) || 7890 } })
      if (!result.success) throw new Error(result.error || text('未知错误', 'Unknown error'))
      setStored(proxy)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (error) {
      setSaved(false)
      const reason = displayedErrorMessage(useLocaleStore.getState().locale, error)
      setSaveError(text(`代理配置保存失败：${reason}`, `Could not save proxy settings: ${reason}`))
    } finally {
      setSaving(false)
    }
  }

  return {
    proxy,
    /** 表单与上次读到或保存的设置不同。 */
    dirty: JSON.stringify(proxy) !== JSON.stringify(stored),
    update: (patch: Partial<ProxyDraft>) => setProxy(previous => ({ ...previous, ...patch })),
    restorePortOnBlur: () => setProxy(previous => (Number(previous.port) ? previous : { ...previous, port: 7890 })),
    saving,
    saved,
    saveError,
    save,
  }
}
