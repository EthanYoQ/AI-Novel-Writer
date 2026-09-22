import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import './styles/redesign/v2-index.css'
/* 「时尚杂志」皮肤（界面版本 v3）。必须排在 v2-index.css 之后 ——
   同为无层样式时「源码在后」者胜，杂志层因此能稳定压过 v2 基座。
   它只在 <html data-mag> 下生效，v1 / v2 完全不受影响。 */
import './styles/magazine/mag-index.css'

/**
 * 渲染进程的 window 级兜底。
 *
 * ErrorBoundary 只接得住「渲染阶段」的错误；事件处理器与异步回调里抛出的
 * 异常会走到 window.onerror / unhandledrejection，若无人接管就是静默失败
 * （按钮卡在忙碌态、数据没保存却毫无提示），排查时也看不到任何线索。
 * 这里统一记录，不阻断界面。
 */
window.addEventListener('error', (event) => {
  console.error('[Vela] 渲染进程未捕获错误：', event.error ?? event.message)
})

window.addEventListener('unhandledrejection', (event) => {
  console.error('[Vela] 渲染进程未处理的 Promise rejection：', event.reason)
})

// App 自身再包一层：v2 外壳的骨架之外还有 AppSkinRoot / 更新提醒等常驻组件，
// 任一处在渲染期抛错都会让整个 root 树被卸载 —— 这一层保证最坏情况仍有降级界面。
class AppRootBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: unknown, info: { componentStack?: string | null }): void {
    console.error('[Vela] 应用根组件崩溃：', error, info?.componentStack)
  }

  render(): React.ReactNode {
    if (this.state.failed) {
      return (
        <div
          style={{
            padding: '32px',
            fontFamily: 'system-ui, sans-serif',
            color: 'var(--ink, #2A261E)',
            background: 'var(--paper, #F6F1E4)',
            minHeight: '100vh',
          }}
        >
          <h1 style={{ fontSize: '16px', margin: '0 0 10px' }}>界面渲染失败</h1>
          <p style={{ fontSize: '13px', lineHeight: 1.7, margin: '0 0 14px' }}>
            你的作品数据保存在项目目录里，没有丢失。请重启应用；若反复出现，请把控制台日志反馈给开发者。
          </p>
          <p style={{ fontSize: '13px', lineHeight: 1.7, margin: 0, color: 'var(--muted, #8F8876)' }}>
            The interface failed to render. Your manuscript is safe in the project folder — please restart the app.
          </p>
        </div>
      )
    }
    return this.props.children
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppRootBoundary>
      <App />
    </AppRootBoundary>
  </React.StrictMode>,
)
