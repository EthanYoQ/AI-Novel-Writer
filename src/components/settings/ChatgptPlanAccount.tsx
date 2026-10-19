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
        : text('登入并授权使用 ChatGPT 订阅，无需 API Key。可用模型与用量依帐号授权为准。', 'Sign in and authorize ChatGPT plan usage. No API key is required. Models and limits depend on your account authorization.')}
    </p>
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={connect}>
        {busy ? text('处理中…', 'Working…') : text('使用 ChatGPT 继续', 'Continue with ChatGPT')}
      </Button>
      {account.connected && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={disconnect}>
        {text('中断 ChatGPT 連接', 'Disconnect ChatGPT')}
      </Button>}
    </div>
    {failed && <p role="alert" className="text-xs text-[var(--color-error-text)]">
      {text('ChatGPT 连接失败，请重试并确认已授权订阅用量。', 'ChatGPT connection failed. Retry and confirm that plan usage is authorized.')}
    </p>}
  </div>
}
