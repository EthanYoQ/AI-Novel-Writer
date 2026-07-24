import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  Download,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  X,
} from 'lucide-react'

import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/Dialog'
import { useLocaleStore } from '../../stores/locale-store'
import { useEditorStore } from '../../stores/editor-store'
import { ipc } from '../../services/ipc-client'
import {
  getUpdatePresentation,
  type UpdateErrorCode,
  type UpdatePresentation,
  type UpdateState,
} from '../../services/update-presentation'

const disabledState: UpdateState = {
  status: 'disabled',
  currentVersion: '',
  isReminderDeferred: false,
}

function getErrorMessage(code: UpdateErrorCode | undefined, text: (zhCNText: string, enUSText: string) => string): string {
  switch (code) {
    case 'UPDATES_DISABLED':
      return text('更新检查仅在已安装的 Windows 应用中可用。', 'Update checks are available in the installed Windows app only.')
    case 'DOWNLOAD_FAILED':
      return text('更新包暂时无法下载。请稍后重试。', 'The update could not be downloaded right now. Please try again later.')
    case 'INSTALL_NOT_READY':
      return text('更新包尚未下载完成，暂时无法重启安装。', 'The update has not finished downloading, so it cannot be installed yet.')
    case 'INSTALL_FAILED':
      return text('无法启动更新安装。请稍后再试。', 'The update installer could not be started. Please try again later.')
    case 'REMINDER_NOT_AVAILABLE':
      return text('当前没有可延后的更新提醒。', 'There is no update reminder to postpone right now.')
    case 'INVALID_REMINDER_DELAY':
      return text('提醒时间无效，请重新选择。', 'That reminder period is unavailable. Please choose again.')
    case 'CHECK_FAILED':
    default:
      return text('暂时无法连接更新服务。请检查网络后重试。', 'The update service is temporarily unavailable. Check your connection and try again.')
  }
}

function getCardCopy(
  presentation: UpdatePresentation,
  state: UpdateState,
  text: (zhCNText: string, enUSText: string) => string,
  manualActionError?: UpdateErrorCode,
) {
  const version = state.availableVersion ? `v${state.availableVersion}` : text('新版本', 'A new version')

  switch (presentation.kind) {
    case 'checking':
      return {
        title: text('正在检查更新', 'Checking for updates'),
        description: text('正在检查 GitHub Release 中的新正式版。', 'Checking GitHub Releases for a new stable version.'),
      }
    case 'not-available':
      return {
        title: text('已是最新版本', 'You are up to date'),
        description: text('当前安装的版本已经是最新正式版。', 'The installed version is already the latest stable release.'),
      }
    case 'available':
      return {
        title: text('发现新版本', 'New version found'),
        description: text(
          `${version} 已可获取。点击“继续准备更新”后，应用会检查并在后台准备安装包。`,
          `${version} is available. Select “Continue preparing update” to check and prepare the installer in the background.`,
        ),
      }
    case 'downloading':
      return {
        title: text('正在下载更新', 'Downloading update'),
        description: text(
          `${version} 正在后台下载，您可以继续创作。`,
          `${version} is downloading in the background. You can keep writing.`,
        ),
      }
    case 'downloaded':
      return {
        title: text('更新已准备就绪', 'Update ready to install'),
        description: text(
          `${version} 已下载完成。重启后将开始安装。`,
          `${version} has finished downloading. Restart to begin installation.`,
        ),
      }
    case 'manual-error':
      return {
        title: text('无法完成更新操作', 'Could not complete update action'),
        description: getErrorMessage(manualActionError ?? state.error?.code, text),
      }
    default:
      return {
        title: '',
        description: '',
      }
  }
}

/** 欢迎页中的更新入口与非阻断状态卡。 */
export function UpdateSection() {
  const text = useLocaleStore(s => s.text)
  const tabs = useEditorStore(s => s.tabs)
  const [state, setState] = useState<UpdateState>(disabledState)
  const [manualCheckRequested, setManualCheckRequested] = useState(false)
  const [manualActionError, setManualActionError] = useState<UpdateErrorCode>()
  const [isDeferring, setIsDeferring] = useState(false)
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false)

  useEffect(() => {
    if (!ipc.isElectron) {
      return undefined
    }

    let mounted = true
    const applyState = (nextState: UpdateState) => {
      if (mounted) setState(nextState)
    }
    const unsubscribe = ipc.on('update:state', applyState)

    void ipc.invoke('update:get-state')
      .then(applyState)
      .catch(() => applyState(disabledState))

    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  const presentation = useMemo(
    () => getUpdatePresentation({ state, manualCheckRequested, manualActionError }),
    [manualActionError, manualCheckRequested, state],
  )
  const cardCopy = getCardCopy(presentation, state, text, manualActionError)
  const dirtyTabCount = tabs.filter(tab => tab.dirty).length
  const progress = Math.round(state.downloadProgress?.percent ?? 0)

  const checkForUpdates = useCallback(async () => {
    if (!presentation.canCheck || !ipc.isElectron) return

    setManualCheckRequested(true)
    setManualActionError(undefined)
    try {
      const response = await ipc.invoke('update:check')
      setState(response.state)
      setManualActionError(response.error?.code)
    } catch {
      setManualActionError('CHECK_FAILED')
    }
  }, [presentation.canCheck])

  const deferReminder = useCallback(async (days: 7 | 30) => {
    if (!presentation.canDefer || !ipc.isElectron) return

    setIsDeferring(true)
    setManualActionError(undefined)
    try {
      const response = await ipc.invoke('update:defer-reminder', days)
      setState(response.state)
      setManualActionError(response.error?.code)
      if (response.success) setManualCheckRequested(false)
    } catch {
      setManualActionError('REMINDER_NOT_AVAILABLE')
    } finally {
      setIsDeferring(false)
    }
  }, [presentation.canDefer])

  const requestInstall = useCallback(async () => {
    if (!presentation.canInstall || !ipc.isElectron) return

    setManualActionError(undefined)
    try {
      const response = await ipc.invoke('update:quit-and-install')
      setState(response.state)
      setManualActionError(response.error?.code)
    } catch {
      setManualActionError('INSTALL_FAILED')
    }
  }, [presentation.canInstall])

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

  const canShowCard = presentation.visible
  const cardIcon = presentation.kind === 'manual-error'
    ? <AlertCircle size={19} />
    : presentation.kind === 'not-available' || presentation.kind === 'downloaded'
      ? <CheckCircle2 size={19} />
      : presentation.kind === 'checking' || presentation.kind === 'downloading'
        ? <LoaderCircle size={19} className="animate-spin" />
        : <Download size={19} />

  return (
    <section className="mb-10" aria-label={text('应用更新', 'App updates')}>
      <div
        className="writer-panel-card flex items-center justify-between gap-4 px-4 py-3"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <RefreshCw size={16} style={{ color: 'var(--color-accent)' }} />
            <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
              {text('应用更新', 'App updates')}
            </span>
          </div>
          <p className="mt-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
            {presentation.kind === 'disabled'
              ? text('更新检查仅在已安装的 Windows 应用中可用。', 'Update checks are available in the installed Windows app only.')
              : text('检查 GitHub Release 中的新正式版。', 'Check GitHub Releases for new stable versions.')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void checkForUpdates()}
          disabled={!presentation.canCheck}
          className="writer-primary-button inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
          title={presentation.kind === 'disabled'
            ? text('请在已安装的 Windows 应用中检查更新', 'Check for updates in the installed Windows app')
            : text('立即检查正式版更新', 'Check for stable updates now')}
        >
          <RefreshCw size={15} className={presentation.kind === 'checking' ? 'animate-spin' : undefined} />
          {presentation.kind === 'checking'
            ? text('正在检查', 'Checking')
            : text('检查更新', 'Check for updates')}
        </button>
      </div>

      {canShowCard && (
        <div
          className="writer-panel-card relative mt-3 overflow-hidden p-4"
          role={presentation.kind === 'manual-error' ? 'alert' : 'status'}
          aria-live="polite"
        >
          {presentation.canDefer && (
            <button
              type="button"
              onClick={() => void deferReminder(7)}
              disabled={isDeferring}
              className="absolute right-3 top-3 rounded-md p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-hover)] disabled:cursor-not-allowed disabled:opacity-50"
              title={text('关闭并在 7 天后提醒', 'Close and remind me in 7 days')}
              aria-label={text('关闭并在 7 天后提醒', 'Close and remind me in 7 days')}
            >
              <X size={16} />
            </button>
          )}

          <div className="flex items-start gap-3 pr-8">
            <div
              className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
              style={{ backgroundColor: 'var(--color-hover)', color: 'var(--color-accent)' }}
            >
              {cardIcon}
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
                {cardCopy.title}
              </h2>
              <p className="mt-1 text-xs leading-5" style={{ color: 'var(--color-text-secondary)' }}>
                {cardCopy.description}
              </p>

              {presentation.showProgress && (
                <div className="mt-3">
                  <div className="mb-1 flex items-center justify-between text-xs" style={{ color: 'var(--color-text-muted)' }}>
                    <span>{text('下载进度', 'Download progress')}</span>
                    <span>{text(`${progress}%`, `${progress}%`)}</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full" style={{ backgroundColor: 'var(--color-hover)' }}>
                    <div
                      className="h-full rounded-full transition-[width] duration-300"
                      style={{ width: `${Math.min(100, Math.max(0, progress))}%`, backgroundColor: 'var(--color-accent)' }}
                    />
                  </div>
                </div>
              )}

              <div className="mt-3 flex flex-wrap items-center gap-2">
                {presentation.kind === 'manual-error' && (
                  <button
                    type="button"
                    onClick={presentation.canInstall ? handleInstallClick : () => void checkForUpdates()}
                    className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors"
                    style={{ backgroundColor: 'var(--color-hover)', color: 'var(--color-text)' }}
                  >
                    <RotateCcw size={14} />
                    {presentation.canInstall
                      ? text('再次尝试重启更新', 'Try restarting the update again')
                      : text('重试检查', 'Retry check')}
                  </button>
                )}

                {presentation.kind === 'available' && (
                  <button
                    type="button"
                    onClick={() => void checkForUpdates()}
                    disabled={!presentation.canCheck}
                    className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                    style={{ backgroundColor: 'var(--color-hover)', color: 'var(--color-text)' }}
                  >
                    <Download size={14} />
                    {text('继续准备更新', 'Continue preparing update')}
                  </button>
                )}

                {presentation.canInstall && (
                  <button
                    type="button"
                    onClick={handleInstallClick}
                    className="writer-primary-button inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium"
                  >
                    <Download size={14} />
                    {text('立即重启更新', 'Restart and update now')}
                  </button>
                )}

                {presentation.canDefer && (
                  <>
                    <button
                      type="button"
                      onClick={() => void deferReminder(7)}
                      disabled={isDeferring}
                      className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                      style={{ backgroundColor: 'var(--color-hover)', color: 'var(--color-text)' }}
                    >
                      <Clock3 size={14} />
                      {text('7 天后提醒', 'Remind me in 7 days')}
                    </button>
                    <button
                      type="button"
                      onClick={() => void deferReminder(30)}
                      disabled={isDeferring}
                      className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                      style={{ backgroundColor: 'var(--color-hover)', color: 'var(--color-text)' }}
                    >
                      <Clock3 size={14} />
                      {text('30 天后提醒', 'Remind me in 30 days')}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <Dialog open={showUnsavedDialog} onOpenChange={setShowUnsavedDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{text('请先处理未保存的修改', 'Handle unsaved changes first')}</DialogTitle>
          </DialogHeader>
          <div className="px-6 py-4">
            <DialogDescription>
              {text(
                `当前有 ${dirtyTabCount} 个未保存的编辑内容。请返回保存，或明确放弃这些修改后再重启更新。`,
                `You have ${dirtyTabCount} unsaved edit${dirtyTabCount === 1 ? '' : 's'}. Go back to save, or explicitly discard them before restarting to update.`,
              )}
            </DialogDescription>
          </div>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setShowUnsavedDialog(false)}
              className="rounded-md px-3 py-2 text-sm font-medium transition-colors"
              style={{ backgroundColor: 'var(--color-hover)', color: 'var(--color-text)' }}
            >
              {text('返回保存', 'Go back and save')}
            </button>
            <button
              type="button"
              onClick={handleDiscardAndInstall}
              className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium"
              style={{ backgroundColor: 'var(--color-danger, #b54747)', color: '#fff' }}
            >
              <Download size={15} />
              {text('放弃修改并重启更新', 'Discard changes and restart update')}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
