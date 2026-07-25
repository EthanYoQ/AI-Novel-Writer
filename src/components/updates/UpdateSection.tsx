import { useCallback, useState } from 'react'
import { Download, ExternalLink, RefreshCw } from 'lucide-react'

import { countUnsavedEditorItems } from '../../stores/editor-unsaved'
import { useEditorStore } from '../../stores/editor-store'
import { useLocaleStore } from '../../stores/locale-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import { ipc } from '../../services/ipc-client'
import { Button } from '../ui/Button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/Dialog'
import { discardChangesThenRequestInstall } from './update-install-discard'
import { UpdateStatusCard } from './UpdateStatusCard'
import { useUpdateState } from './use-update-state'

/** 欢迎页中的更新入口与非阻断状态卡。 */
export function UpdateSection() {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const tabs = useEditorStore(s => s.tabs)
  const draftLedgers = useEditorStore(s => s.draftLedgers)
  const activeRuns = useWorkflowStore(s => s.activeRuns)
  const [showWorkflowBlockingDialog, setShowWorkflowBlockingDialog] = useState(false)
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false)
  const [officialHomepageError, setOfficialHomepageError] = useState<string | null>(null)
  const {
    state,
    presentation,
    manualActionError,
    isDeferring,
    lastReminderDays,
    checkForUpdates,
    deferReminder,
    requestInstall,
  } = useUpdateState()
  const unsavedItemCount = countUnsavedEditorItems(tabs, draftLedgers)

  const handleInstallClick = useCallback(() => {
    // 活跃任务集合中标记为已完成或失败的任务，也可能正处在最终落盘和移入历史之间，
    // 因此不能只检查运行中、已暂停或等待中的状态。
    if (useWorkflowStore.getState().activeRuns.length > 0) {
      setShowWorkflowBlockingDialog(true)
      return
    }
    if (unsavedItemCount > 0) {
      setShowUnsavedDialog(true)
      return
    }
    void requestInstall()
  }, [requestInstall, unsavedItemCount])

  const handleDiscardAndInstall = useCallback(() => {
    setShowUnsavedDialog(false)
    // 用户停留在未保存确认框期间也可能启动任务，最终安装动作前必须再次检查。
    if (useWorkflowStore.getState().activeRuns.length > 0) {
      setShowWorkflowBlockingDialog(true)
      return
    }
    void discardChangesThenRequestInstall(requestInstall)
  }, [requestInstall])

  const handleOfficialHomepageClick = useCallback(async () => {
    setOfficialHomepageError(null)
    try {
      const result = await ipc.invoke('official-homepage:open')
      if (!result.success) throw new Error(result.error)
    } catch {
      setOfficialHomepageError(text(
        '无法打开官方主页，请稍后重试。',
        'Unable to open the official homepage. Please try again later.',
      ))
    }
  }, [text])

  return <section className="mb-10" lang={locale} aria-label={text('应用更新', 'App updates')}>
    <div className="writer-panel-card flex items-center justify-between gap-4 px-4 py-3" style={{ borderColor: 'var(--color-border)' }}>
      <div className="min-w-0">
        <div className="flex items-center gap-2"><RefreshCw size={16} style={{ color: 'var(--color-accent)' }} /><span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>{text('应用更新', 'App updates')}</span></div>
        <p className="mt-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>{presentation.kind === 'disabled' ? text('更新检查仅在已安装的 Windows 应用中可用。', 'Update checks are available in the installed Windows app only.') : text('检查 GitHub Release 中的新正式版。', 'Check GitHub Releases for new stable versions.')}</p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2" data-testid="update-entry-actions">
        <Button type="button" size="lg" variant="outline" onClick={() => void handleOfficialHomepageClick()} className="text-sm" title={text('在默认浏览器中打开官方主页', 'Open the official homepage in your default browser')}>
          <ExternalLink size={15} aria-hidden="true" />{text('官方主页', 'Official homepage')}
        </Button>
        <Button type="button" size="lg" onClick={() => void checkForUpdates()} disabled={!presentation.canCheck} className="text-sm" title={presentation.kind === 'disabled' ? text('请在已安装的 Windows 应用中检查更新', 'Check for updates in the installed Windows app') : text('立即检查正式版更新', 'Check for stable updates now')}>
          <RefreshCw size={15} className={presentation.kind === 'checking' ? 'animate-spin' : undefined} />{presentation.kind === 'checking' ? text('正在检查', 'Checking') : text('检查更新', 'Check for updates')}
        </Button>
      </div>
    </div>

    {officialHomepageError && <p role="alert" className="mt-2 px-1 text-xs" style={{ color: 'var(--color-error)' }}>{officialHomepageError}</p>}

    {presentation.visible && <UpdateStatusCard presentation={presentation} state={state} text={text} manualActionError={manualActionError} isDeferring={isDeferring} lastReminderDays={lastReminderDays} onCheck={() => void checkForUpdates()} onDefer={days => void deferReminder(days)} onInstall={handleInstallClick} />}

    <Dialog open={showWorkflowBlockingDialog} onOpenChange={setShowWorkflowBlockingDialog}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{text('创作任务尚未结束，暂不能更新', 'Creative tasks are not finished yet')}</DialogTitle></DialogHeader>
        <div className="px-6 py-4"><DialogDescription>{text(`当前有 ${activeRuns.length} 个创作任务仍在运行、暂停、等待继续或正在收尾，结果可能尚未完整写入项目。为避免内容丢失，请先完成或取消这些任务，再重启更新。`, `${activeRuns.length} creative task${activeRuns.length === 1 ? ' is' : 's are'} still running, paused, waiting, or being finalized, so results may not be fully saved yet. Finish or cancel the tasks before restarting to update.`)}</DialogDescription></div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => setShowWorkflowBlockingDialog(false)}>{text('知道了，返回处理任务', 'Got it, return to tasks')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={showUnsavedDialog} onOpenChange={setShowUnsavedDialog}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{text('请先处理未保存的修改', 'Handle unsaved changes first')}</DialogTitle></DialogHeader>
        <div className="px-6 py-4"><DialogDescription>{text(`当前有 ${unsavedItemCount} 项未保存的编辑内容。请返回保存，或明确放弃这些修改后再重启更新。`, `You have ${unsavedItemCount} unsaved edit${unsavedItemCount === 1 ? '' : 's'}. Go back to save, or explicitly discard them before restarting to update.`)}</DialogDescription></div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => setShowUnsavedDialog(false)}>{text('返回保存', 'Go back and save')}</Button>
          <Button type="button" variant="destructive" onClick={handleDiscardAndInstall}><Download size={15} />{text('放弃修改并重启更新', 'Discard changes and restart update')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </section>
}
