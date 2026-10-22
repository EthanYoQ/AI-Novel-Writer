import { useEffect, useState } from 'react'
import { ipc } from '../../services/ipc-client'
import { useLocaleStore } from '../../stores/locale-store'
import { displayedErrorMessage } from '../../i18n/app-errors'

/** 「定稿后打开下一章」开关：读取、乐观写入、失败回滚并给出原因。 */
export function useAutoOpenNextChapter() {
  const text = useLocaleStore(s => s.text)
  const [enabled, setEnabled] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    ipc.invoke('config:get').then((config) => {
      setEnabled(config.autoOpenNextChapterAfterFinalize === true)
    }).catch(() => {})
  }, [])

  const set = async (checked: boolean) => {
    const previous = enabled
    setEnabled(checked)
    setSaving(true)
    setError(null)
    try {
      const result = await ipc.invoke('config:set', { autoOpenNextChapterAfterFinalize: checked })
      if (!result.success) throw new Error(result.error || text('未知错误', 'Unknown error'))
    } catch (cause) {
      setEnabled(previous)
      const reason = displayedErrorMessage(useLocaleStore.getState().locale, cause)
      setError(text(`自动打开下一章设置保存失败：${reason}`, `Could not save the open-next-chapter setting: ${reason}`))
    } finally {
      setSaving(false)
    }
  }

  return { enabled, saving, error, set }
}
