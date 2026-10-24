import { useState, type CSSProperties } from 'react'
import { CircleAlert, CircleCheck, Download, ExternalLink, LoaderCircle, RefreshCw } from 'lucide-react'
import { ipc } from '../../services/ipc-client'
import type { UpdatePresentation } from '../../services/update-presentation'
import { getOfficialHomepageOpenError } from '../../shared/official-homepage'
import { useLocaleStore } from '../../stores/locale-store'
import { getUpdateCardCopy } from '../updates/update-card-copy'
import { getUpdateRetryAction } from '../updates/update-retry-action'
import { useUpdateInstallGuard } from '../updates/use-update-install-guard'
import { useUpdateState } from '../updates/use-update-state'
import { Button } from '../ui/Button'
import { DangerConfirm } from '../ui/DangerConfirm'
import { Menu } from '../ui/Menu'
import { InkDialog } from './InkDialog'

type UpdateModel = ReturnType<typeof useUpdateState>
type InstallGuard = ReturnType<typeof useUpdateInstallGuard>

function StatusIcon({ kind }: { kind: UpdatePresentation['kind'] }) {
  if (kind === 'manual-error') return <CircleAlert aria-hidden="true" />
  if (kind === 'not-available' || kind === 'downloaded') return <CircleCheck aria-hidden="true" />
  if (kind === 'checking' || kind === 'downloading') return <LoaderCircle className="stage-update-spin" aria-hidden="true" />
  return <Download aria-hidden="true" />
}

/** 重启更新被拦下时的两种对话框：有任务只能返回处理；有未保存修改时返回保存，或放弃修改后重启。 */
function InstallBlockedDialogs({ guard }: { guard: InstallGuard }) {
  const text = useLocaleStore(s => s.text)
  const { block, dismiss, discardAndInstall, unsavedItemCount, activeRunCount } = guard
  return (
    <>
      <InkDialog
        open={block === 'workflow'}
        onOpenChange={open => { if (!open) dismiss('workflow') }}
        title={text('创作任务尚未结束，暂不能更新', 'Creative tasks are not finished yet')}
        description={text(
          `当前有 ${activeRunCount} 个创作任务仍在运行、暂停、等待继续或正在收尾，结果可能尚未完整写入作品。请先完成或取消这些任务，再重启更新。`,
          `${activeRunCount} creative task${activeRunCount === 1 ? ' is' : 's are'} still running, paused, waiting, or being finalized. Finish or cancel them before restarting to update.`,
        )}
        footer={<Button variant="primary" onClick={() => dismiss('workflow')}>{text('知道了，返回处理任务', 'Got it, return to tasks')}</Button>}
      />
      <DangerConfirm
        open={block === 'unsaved'}
        onOpenChange={open => { if (!open) dismiss('unsaved') }}
        title={text('请先处理未保存的修改', 'Handle unsaved changes first')}
        consequence={text(
          `当前有 ${unsavedItemCount} 项未保存的修改。重启更新会关闭应用。`,
          `You have ${unsavedItemCount} unsaved edit${unsavedItemCount === 1 ? '' : 's'}. Restarting to update closes the app.`,
        )}
        recoverability={text('放弃的修改无法恢复。想保留就选「返回保存」。', 'Discarded edits cannot be recovered. Choose “Go back and save” to keep them.')}
        cancelLabel={text('返回保存', 'Go back and save')}
        confirmLabel={text('放弃修改并重启更新', 'Discard changes and restart')}
        onConfirm={discardAndInstall}
      />
    </>
  )
}

/** 当前状态下可做的事。主操作只有一个，延后提醒是次要的文字按钮。 */
function UpdateActions({ model, guard, compact }: { model: UpdateModel; guard: InstallGuard; compact: boolean }) {
  const text = useLocaleStore(s => s.text)
  const { presentation, manualActionError, state, isDeferring, lastReminderDays } = model
  if (presentation.kind === 'manual-error') {
    const error = manualActionError ?? state.error
    if (error && !error.retryable) return null
    const retry = {
      install: { label: text('再次尝试重启更新', 'Try restarting the update again'), run: guard.install },
      defer: { label: text('重试保存提醒时间', 'Retry saving the reminder'), run: () => void model.deferReminder(lastReminderDays) },
      download: { label: text('重试下载更新', 'Retry download'), run: () => void model.downloadUpdate() },
      'open-release': { label: text('重试打开下载页', 'Retry opening download page'), run: () => void model.openRelease() },
      check: { label: text('重试检查', 'Retry check'), run: () => void model.checkForUpdates() },
    }[getUpdateRetryAction(error?.code)]
    return <div className="stage-update-actions"><Button variant="secondary" size="sm" onClick={retry.run}>{retry.label}</Button></div>
  }
  const defer = presentation.canDefer && (compact
    ? (
      <Menu
        label={text('稍后提醒', 'Remind me later')}
        trigger={{ content: text('稍后提醒', 'Remind me later'), size: 'sm' }}
        groups={[{ id: 'later', items: [
          { id: '7', label: text('7 天后提醒', 'In 7 days'), disabled: isDeferring, onSelect: () => void model.deferReminder(7) },
          { id: '30', label: text('30 天后提醒', 'In 30 days'), disabled: isDeferring, onSelect: () => void model.deferReminder(30) },
        ] }]}
      />
    )
    : (
      <>
        <Button variant="text" size="sm" disabled={isDeferring} onClick={() => void model.deferReminder(7)}>{text('7 天后提醒', 'Remind me in 7 days')}</Button>
        <Button variant="text" size="sm" disabled={isDeferring} onClick={() => void model.deferReminder(30)}>{text('30 天后提醒', 'Remind me in 30 days')}</Button>
      </>
    ))
  return (
    <div className="stage-update-actions">
      {presentation.canDownload && <Button variant="secondary" size="sm" onClick={() => void model.downloadUpdate()}>{text('下载更新', 'Download update')}</Button>}
      {presentation.canOpenRelease && (
        <Button variant="secondary" size="sm" onClick={() => void model.openRelease()}>
          <ExternalLink size={13} aria-hidden="true" />{text('打开下载页', 'Open download page')}
        </Button>
      )}
      {presentation.canInstall && <Button variant="secondary" size="sm" onClick={guard.install}>{text('立即重启更新', 'Restart and update now')}</Button>}
      {defer}
    </div>
  )
}

function UpdateStatus({ model, guard, compact }: { model: UpdateModel; guard: InstallGuard; compact: boolean }) {
  const text = useLocaleStore(s => s.text)
  const { presentation, state, manualActionError } = model
  const copy = getUpdateCardCopy(presentation, state, text, manualActionError)
  const progress = Math.min(100, Math.max(0, Math.round(state.downloadProgress?.percent ?? 0)))
  return (
    <section
      className="stage-update"
      data-kind={presentation.kind}
      role={presentation.kind === 'manual-error' ? 'alert' : 'status'}
      aria-live="polite"
      aria-label={text('应用更新', 'App updates')}
    >
      <span className="stage-update-icon"><StatusIcon kind={presentation.kind} /></span>
      <div className="stage-update-body">
        <p className="stage-update-title">{copy.title}</p>
        <p className="stage-update-text">{copy.description}</p>
        {presentation.showProgress && (
          <div className="stage-update-progress" role="progressbar" aria-label={text('下载进度', 'Download progress')} aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ '--w': `${progress}%` } as CSSProperties} />
            <b className="pi-num">{progress}%</b>
          </div>
        )}
        <UpdateActions model={model} guard={guard} compact={compact} />
      </div>
    </section>
  )
}

/** 书房里的更新提示：只在发现新版本、下载中、待重启或出错时出现。检查更新与官方主页在设置的「关于与更新」。 */
export function LibraryUpdateCard() {
  const model = useUpdateState()
  const guard = useUpdateInstallGuard(model.requestInstall)
  const show = model.presentation.visible && model.presentation.kind !== 'checking' && model.presentation.kind !== 'not-available'
  return (
    <>
      {show && <UpdateStatus model={model} guard={guard} compact />}
      <InstallBlockedDialogs guard={guard} />
    </>
  )
}

/** 设置「关于与更新」里的应用更新：官方主页、检查更新与完整状态。 */
export function UpdateSettings() {
  const text = useLocaleStore(s => s.text)
  const model = useUpdateState()
  const guard = useUpdateInstallGuard(model.requestInstall)
  const [homepageError, setHomepageError] = useState<string | null>(null)
  const { presentation } = model

  const openHomepage = async () => {
    setHomepageError(null)
    try {
      const result = await ipc.invoke('official-homepage:open')
      if (!result.success) throw new Error(result.error)
    } catch {
      setHomepageError(getOfficialHomepageOpenError(useLocaleStore.getState().locale))
    }
  }

  return (
    <div className="stage-update-settings">
      <div className="stage-set-row">
        <div>
          <p className="stage-set-row-title">{text('检查更新', 'Check for updates')}</p>
          <p className="stage-set-row-desc">{presentation.kind === 'disabled'
            ? text('更新检查只在已安装的 Windows 或 macOS 应用中可用。', 'Update checks are available in the installed Windows or macOS app only.')
            : text('从 GitHub Release 检查新的正式版。', 'Check GitHub Releases for new stable versions.')}</p>
        </div>
        <div className="stage-set-row-ctl">
          <Button variant="text" size="sm" onClick={() => void openHomepage()}>
            <ExternalLink size={13} aria-hidden="true" />{text('官方主页', 'Official website')}
          </Button>
          <Button variant="secondary" size="sm" disabled={!presentation.canCheck} onClick={() => void model.checkForUpdates()}>
            <RefreshCw size={13} className={presentation.kind === 'checking' ? 'stage-update-spin' : undefined} aria-hidden="true" />
            {presentation.kind === 'checking' ? text('正在检查', 'Checking') : text('检查更新', 'Check for updates')}
          </Button>
        </div>
      </div>
      {homepageError && <p className="stage-set-error" role="alert">{homepageError}</p>}
      {presentation.visible && <UpdateStatus model={model} guard={guard} compact={false} />}
      <InstallBlockedDialogs guard={guard} />
    </div>
  )
}
