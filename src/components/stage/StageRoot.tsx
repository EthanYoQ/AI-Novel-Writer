import type { ReactNode } from 'react'
import { useLocaleStore } from '../../stores/locale-store'
import type { Theme } from '../../stores/theme-store'
import { ErrorBoundary } from '../ErrorBoundary'
import type { WindowCloseGuard } from '../layout/use-window-close-guard'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import ExitGuardDialog from './ExitGuardDialog'

/** 外壳渲染出错：已打开的页面与没保存的内容还在内存里，重试重新显示界面；关窗时退出确认照常问保存。 */
function StageFallback({ retry }: { retry: () => void }) {
  const text = useLocaleStore(s => s.text)
  return (
    <main className="stage-fallback">
      <EmptyState
        heading={text('创作流程界面出错了', 'The creative flow layout ran into a problem')}
        description={text(
          '已打开的页面和没保存的内容都还在。点重试重新显示界面；仍然出错就关闭窗口，关闭前会问你是否保存。',
          'Your open pages and unsaved changes are kept. Retry to show the layout again. If it keeps failing, close the window; you will be asked whether to save first.',
        )}
        action={<Button variant="primary" onClick={retry}>{text('重试', 'Retry')}</Button>}
      />
    </main>
  )
}

/**
 * 外壳的根：纸墨作用域、渲染出错兜底与退出确认。
 * 退出确认挂在外壳之外，外壳渲染出错后关窗仍能保存或放弃未保存的内容。
 */
export default function StageRoot({ theme, exitGuard, children }: { theme: Theme; exitGuard: WindowCloseGuard; children: ReactNode }) {
  return (
    <div className="paper-ink stage-root" data-theme={theme}>
      <ErrorBoundary fallback={retry => <StageFallback retry={retry} />}>{children}</ErrorBoundary>
      <ExitGuardDialog guard={exitGuard} />
    </div>
  )
}
