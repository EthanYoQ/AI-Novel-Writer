import { useCallback, useState } from 'react'
import { Download, RefreshCw } from 'lucide-react'

import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/Dialog'
import { useLocaleStore } from '../../stores/locale-store'
import { useEditorStore } from '../../stores/editor-store'
import { UpdateStatusCard } from './UpdateStatusCard'
import { useUpdateState } from './use-update-state'

/** 欢迎页中的更新入口与非阻断状态卡。 */
export function UpdateSection() {
  const text = useLocaleStore(s => s.text)
  const tabs = useEditorStore(s => s.tabs)
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false)
  const {
    state,
    presentation,
    manualActionError,
    isDeferring,
    checkForUpdates,
    deferReminder,
    requestInstall,
  } = useUpdateState()
  const dirtyTabCount = tabs.filter(tab => tab.dirty).length

  const handleInstallClick = useCallback(() => {
    if (dirtyTabCount > 0) {
      setShowUnsavedDialog(true)
      return
    }
    void requestInstall()
  }, [dirtyTabCount, requestInstall])

  const handleDiscardAndInstall = useCallback(() => {
    setShowUnsavedDialog(false)
    void requestInstall()
  }, [requestInstall])

  return <section className="mb-10" aria-label={text('应用更新', 'App updates')}>
    <div className="writer-panel-card flex items-center justify-between gap-4 px-4 py-3" style={{ borderColor: 'var(--color-border)' }}>
      <div className="min-w-0">
        <div className="flex items-center gap-2"><RefreshCw size={16} style={{ color: 'var(--color-accent)' }} /><span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>{text('应用更新', 'App updates')}</span></div>
        <p className="mt-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>{presentation.kind === 'disabled' ? text('更新检查仅在已安装的 Windows 应用中可用。', 'Update checks are available in the installed Windows app only.') : text('检查 GitHub Release 中的新正式版。', 'Check GitHub Releases for new stable versions.')}</p>
      </div>
      <button type="button" onClick={() => void checkForUpdates()} disabled={!presentation.canCheck} className="writer-primary-button inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-opacity disabled:cursor-not-allowed disabled:opacity-50" title={presentation.kind === 'disabled' ? text('请在已安装的 Windows 应用中检查更新', 'Check for updates in the installed Windows app') : text('立即检查正式版更新', 'Check for stable updates now')}>
        <RefreshCw size={15} className={presentation.kind === 'checking' ? 'animate-spin' : undefined} />{presentation.kind === 'checking' ? text('正在检查', 'Checking') : text('检查更新', 'Check for updates')}
      </button>
    </div>

    {presentation.visible && <UpdateStatusCard presentation={presentation} state={state} text={text} manualActionError={manualActionError} isDeferring={isDeferring} onCheck={() => void checkForUpdates()} onDefer={days => void deferReminder(days)} onInstall={handleInstallClick} />}

    <Dialog open={showUnsavedDialog} onOpenChange={setShowUnsavedDialog}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{text('请先处理未保存的修改', 'Handle unsaved changes first')}</DialogTitle></DialogHeader>
        <div className="px-6 py-4"><DialogDescription>{text(`当前有 ${dirtyTabCount} 个未保存的编辑内容。请返回保存，或明确放弃这些修改后再重启更新。`, `You have ${dirtyTabCount} unsaved edit${dirtyTabCount === 1 ? '' : 's'}. Go back to save, or explicitly discard them before restarting to update.`)}</DialogDescription></div>
        <DialogFooter>
          <button type="button" onClick={() => setShowUnsavedDialog(false)} className="rounded-md px-3 py-2 text-sm font-medium transition-colors" style={{ backgroundColor: 'var(--color-hover)', color: 'var(--color-text)' }}>{text('返回保存', 'Go back and save')}</button>
          <button type="button" onClick={handleDiscardAndInstall} className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium" style={{ backgroundColor: 'var(--color-danger, #b54747)', color: '#fff' }}><Download size={15} />{text('放弃修改并重启更新', 'Discard changes and restart update')}</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </section>
}
