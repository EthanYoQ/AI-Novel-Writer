import { useEffect, useState } from 'react'
import { ipc } from '../../services/ipc-client'
import { useLocaleStore } from '../../stores/locale-store'
import { Button } from '../ui/Button'

export function ChatgptPlanAccount({ onChanged }: { onChanged: () => void }) {
  const text = useLocaleStore(s => s.text)
  const [account, setAccount] = useState<{ connected: boolean; email?: string }>({ connected: false })
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let active = true
    void ipc.invoke('llm:chatgpt-status').then(result => {
      if (active) { setAccount(result); setFailed(!result.success) }
    }).catch(() => { if (active) setFailed(true) })
    return () => { active = false }
  }, [])
  const connect = async () => {
    setBusy(true)
    setFailed(false)
    try {
      const result = await ipc.invoke('llm:chatgpt-sign-in')
      if (result.success) { setAccount(result); onChanged() }
      else setFailed(true)
    } catch { setFailed(true) }
    finally { setBusy(false) }
  }
  const disconnect = async () => {
    setBusy(true)
    setFailed(false)
    try {
      const result = await ipc.invoke('llm:chatgpt-disconnect')
      if (result.success) { setAccount({ connected: false }); onChanged() }
      else setFailed(true)
    } catch { setFailed(true) }
    finally { setBusy(false) }
  }
  return <div className="space-y-2">
    <p className="text-xs text-[var(--color-text-secondary)]">
      {account.connected
        ? text(`已連接 ChatGPT：${account.email ?? ''}`, `Connected to ChatGPT: ${account.email ?? ''}`)
        : text('登入並授權使用 ChatGPT 訂閱，無需 API Key。可用模型與用量依帳號授權為準。', 'Sign in and authorize ChatGPT plan usage. No API key is required. Models and limits depend on your account authorization.')}
    </p>
    <Button type="button" size="sm" variant="outline" disabled={busy} onClick={connect}>
      {busy ? text('處理中…', 'Working…') : text('使用 ChatGPT 繼續', 'Continue with ChatGPT')}
    </Button>
    {account.connected && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={disconnect}>
      {text('中斷 ChatGPT 連接', 'Disconnect ChatGPT')}
    </Button>}
    {failed && <p role="alert" className="text-xs text-[var(--color-error-text)]">
      {text('ChatGPT 連接失敗，請重試並確認已授權訂閱用量。', 'ChatGPT connection failed. Retry and confirm that plan usage is authorized.')}
    </p>}
  </div>
}
