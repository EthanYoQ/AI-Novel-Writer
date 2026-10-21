import { useId } from 'react'
import { useLocaleStore } from '../../../stores/locale-store'
import { useUnsavedSettings } from '../../settings/unsaved-settings'
import { useProxySettings } from '../../settings/use-proxy-settings'
import { Button } from '../../ui/Button'
import { Check } from '../../ui/Check'

/** 网络代理：开关、类型、主机与端口，保存后所有 AI 请求都走代理。 */
export default function ProxySection() {
  const text = useLocaleStore(s => s.text)
  const { proxy, dirty, update, restorePortOnBlur, saving, saved, saveError, save } = useProxySettings()
  useUnsavedSettings(dirty)
  const typeId = useId()
  const hostId = useId()
  const portId = useId()
  return (
    <div className="stage-set-rows">
      <div className="stage-set-row">
        <div>
          <p className="stage-set-row-title">{text('启用代理', 'Use a proxy')}</p>
          <p className="stage-set-row-desc">{text('关闭时直接连接模型服务。', 'When off, model services are reached directly.')}</p>
        </div>
        <div className="stage-set-row-ctl">
          <Check kind="switch" checked={proxy.enabled} onChange={enabled => update({ enabled })}
            label={<span className="stage-visually-hidden">{text('启用代理', 'Use a proxy')}</span>} />
        </div>
      </div>
      {proxy.enabled && (
        <div className="stage-set-form">
          <div className="stage-set-field">
            <label htmlFor={typeId}>{text('代理类型', 'Proxy type')}</label>
            <select id={typeId} className="stage-select" value={proxy.type} onChange={event => update({ type: event.target.value as 'http' | 'socks5' })}>
              <option value="http">HTTP</option>
              <option value="socks5">SOCKS5</option>
            </select>
          </div>
          <div className="stage-set-field stage-set-field--grow">
            <label htmlFor={hostId}>{text('主机地址', 'Host')}</label>
            <input id={hostId} className="pi-input" value={proxy.host} placeholder="127.0.0.1" onChange={event => update({ host: event.target.value })} />
          </div>
          <div className="stage-set-field">
            <label htmlFor={portId}>{text('端口', 'Port')}</label>
            <input id={portId} className="pi-input" type="number" value={proxy.port} onBlur={restorePortOnBlur}
              onChange={event => update({ port: event.target.value === '' ? '' : Number.parseInt(event.target.value, 10) })} />
          </div>
        </div>
      )}
      <div className="stage-set-actions">
        {saveError && <p className="stage-set-error" role="alert">{saveError}</p>}
        <span className="stage-set-saved" role="status">{saved ? text('已保存', 'Saved') : ''}</span>
        <Button variant="primary" disabled={saving} onClick={() => void save()}>
          {saving ? text('正在保存…', 'Saving…') : text('保存代理设置', 'Save proxy settings')}
        </Button>
      </div>
    </div>
  )
}
